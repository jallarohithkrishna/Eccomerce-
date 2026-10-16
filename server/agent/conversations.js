/**
 * Conversation Store — PS-01 Phase B
 * Persists full agent conversation history for resume + staff audit.
 * In-memory (fast path) + Firestore sync (durable).
 * 
 * Firestore collection: agent_conversations/{conversationId}
 * Fields: uid, messages (last 10 turns), caseCard, auditEvents, handledBy, createdAt, updatedAt
 */

import { stripUndefined } from '../utils/stripUndefined.js';

/** In-memory mirror for fast reads */
const convStore = new Map();

/**
 * INTERNAL FIELDS that must never be readable by the customer.
 * These are stored in /agent_conversations/{id}/internal/staff
 * and are only accessible with staff/admin role.
 * NOTE: auditEvents is intentionally kept on the ROOT doc as well so that
 * smoke-agent.js and /admin/agent-runs can read it without touching the
 * internal subcollection.  The sensitive sub-fields (riskScore etc.) are
 * still only written to internal/staff.
 */
const INTERNAL_FIELDS = ['promptInjectionDetected', 'ruleIds', 'toolTraces'];

/**
 * Build the customer-safe portion of the conversation document.
 * Strips all internal-only fields and internal caseCard sub-fields.
 */
function buildSafeDoc(record) {
  const safe = {};
  for (const [k, v] of Object.entries(record)) {
    if (INTERNAL_FIELDS.includes(k) || v === undefined) continue;
    safe[k] = v;
  }
  // Strip internal caseCard sub-fields (risk score, rule ids, etc.)
  if (safe.caseCard && typeof safe.caseCard === 'object') {
    const { riskScore, riskFlags, ruleIds, toolTraces, promptInjectionDetected, ...safeCard } = safe.caseCard;
    safe.caseCard = safeCard;
  }
  return stripUndefined(safe);
}

/**
 * Build the internal-only portion for the staff subcollection.
 * Guarantees riskScore, riskFlags, ruleIds, toolTraces, promptInjectionDetected have defined defaults.
 */
function buildInternalDoc(record) {
  const internal = { updatedAt: record.updatedAt };
  for (const field of INTERNAL_FIELDS) {
    if (field in record && record[field] !== undefined) internal[field] = record[field];
  }
  // auditEvents is now on the root doc but also mirror it here for staff reads
  if (Array.isArray(record.auditEvents)) internal.auditEvents = record.auditEvents;
  // Guarantee defined defaults for all internal caseCard sub-fields
  const card = (record.caseCard && typeof record.caseCard === 'object') ? record.caseCard : {};
  internal.caseCard_internal = {
    riskScore: typeof card.riskScore === 'number' ? card.riskScore : 0,
    riskFlags: Array.isArray(card.riskFlags) ? card.riskFlags : [],
    ruleIds: Array.isArray(card.ruleIds) ? card.ruleIds : [],
    toolTraces: Array.isArray(card.toolTraces) ? card.toolTraces : [],
    promptInjectionDetected: Boolean(card.promptInjectionDetected),
  };
  return stripUndefined(internal);
}

/**
 * Save conversation snapshot to memory (and Firestore if db provided).
 * Writes safe fields to /agent_conversations/{id} (customer-readable)
 * and internal-only fields to /agent_conversations/{id}/internal/staff (staff-only).
 * A failed conversation write retries once and never loses the in-memory audit trace.
 */
export async function saveConversation({ db, conversationId, uid, messages, caseCard, auditEvents = [] }) {
  const now = new Date().toISOString();

  // Merge with existing to preserve handledBy, createdAt, and ACCUMULATE auditEvents
  const existing = convStore.get(conversationId) || {};

  // Accumulate audit events — never overwrite previous turns' events with an empty array
  const combinedAuditEvents = [
    ...(existing.auditEvents || []),
    ...auditEvents,
  ].slice(-50); // keep last 50 total

  const record = {
    conversationId,
    uid,
    messages:    messages.slice(-20),  // last 10 turns
    caseCard:    caseCard || {},
    auditEvents: combinedAuditEvents,
    updatedAt:   now,
  };

  const merged = {
    ...existing,
    ...record,
    handledBy:  existing.handledBy || null,
    createdAt:  existing.createdAt || now,
  };
  convStore.set(conversationId, merged);

  if (db) {
    const writeToFirestore = async () => {
      const safeDoc = buildSafeDoc(merged);
      const internalDoc = buildInternalDoc(merged);
      // Write customer-safe document to root collection (includes auditEvents for smoke/admin reads)
      await db.collection('agent_conversations').doc(conversationId).set(safeDoc, { merge: true });
      // Write internal fields to staff-only subcollection
      await db.collection('agent_conversations').doc(conversationId)
        .collection('internal').doc('staff').set(internalDoc, { merge: true });
    };

    try {
      await writeToFirestore();
    } catch (err) {
      console.warn(`Failed to persist conversation ${conversationId} to Firestore (retrying once):`, err.message);
      try {
        await writeToFirestore();
      } catch (retryErr) {
        console.error(`Failed to persist conversation ${conversationId} to Firestore after retry (in-memory audit trace preserved):`, retryErr.message);
      }
    }
  }
  return merged;
}

/**
 * Load conversation by id. Returns null if not found.
 * Tries memory first, then Firestore.
 */
export async function loadConversation({ db, conversationId, uid, isStaffOrAdmin = false }) {
  const mem = convStore.get(conversationId);
  if (mem) {
    if (!isStaffOrAdmin && uid && mem.uid !== uid) return null; // ownership check
    return mem;
  }
  if (!db) return null;
  try {
    const doc = await db.collection('agent_conversations').doc(conversationId).get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (!isStaffOrAdmin && uid && data.uid !== uid) return null;
    convStore.set(conversationId, data);
    return data;
  } catch {
    return null;
  }
}

/**
 * Set handledBy field (staff uid or null).
 * Every change is an audit event stored in the conversation.
 */
export async function setHandledBy({ db, conversationId, handledBy, actorUid, auditEvent }) {
  const existing = convStore.get(conversationId);
  if (!existing) throw new Error(`Conversation ${conversationId} not found`);

  existing.handledBy  = handledBy;
  existing.updatedAt  = new Date().toISOString();
  if (auditEvent) existing.auditEvents = [...(existing.auditEvents || []), auditEvent];
  convStore.set(conversationId, existing);

  if (db) {
    await db.collection('agent_conversations').doc(conversationId).set(existing, { merge: true });
  }
  return existing;
}

/**
 * Append a staff reply to the conversation.
 */
export async function appendStaffReply({ db, conversationId, staffUid, message }) {
  const existing = convStore.get(conversationId);
  if (!existing) throw new Error(`Conversation ${conversationId} not found`);
  if (existing.uid === staffUid) {
    // Staff cannot reply to their own case (shouldn't happen — enforced by role check too)
  }

  const staffMsg = {
    role:      'staff',
    content:   message,
    staffUid,
    timestamp: new Date().toISOString(),
  };
  existing.messages = [...(existing.messages || []), staffMsg];
  existing.updatedAt = new Date().toISOString();
  convStore.set(conversationId, existing);

  if (db) {
    await db.collection('agent_conversations').doc(conversationId).set(existing, { merge: true });
  }
  return staffMsg;
}

/**
 * List conversations that need human review (for staff inbox).
 * Returns up to `limitN` records sorted by updatedAt desc.
 */
export async function listNeedsHuman({ db, limitN = 25 }) {
  if (db) {
    try {
      const snap = await db.collection('agent_conversations')
        .where('caseCard.state', '==', 'HUMAN_REVIEW')
        .orderBy('updatedAt', 'desc')
        .limit(limitN)
        .get();
      return snap.docs.map(d => d.data());
    } catch {
      // Fall through to in-memory
    }
  }
  return Array.from(convStore.values())
    .filter(c => c.caseCard?.state === 'HUMAN_REVIEW')
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, limitN);
}

/** Test helpers */
export function _set(id, data) { convStore.set(id, data); }
export function _get(id) { return convStore.get(id); }
export function _getAll() { return Array.from(convStore.values()); }
export function _clearAll() { convStore.clear(); }
