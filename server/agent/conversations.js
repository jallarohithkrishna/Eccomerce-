/**
 * Conversation Store — PS-01 Phase B
 * Persists full agent conversation history for resume + staff audit.
 * In-memory (fast path) + Firestore sync (durable).
 * 
 * Firestore collection: agent_conversations/{conversationId}
 * Fields: uid, messages (last 10 turns), caseCard, auditEvents, handledBy, createdAt, updatedAt
 */

/** In-memory mirror for fast reads */
const convStore = new Map();

/**
 * Save conversation snapshot to memory (and Firestore if db provided).
 */
export async function saveConversation({ db, conversationId, uid, messages, caseCard, auditEvents = [] }) {
  const now = new Date().toISOString();
  const record = {
    conversationId,
    uid,
    messages:    messages.slice(-20),  // last 10 turns
    caseCard:    caseCard || {},
    auditEvents: auditEvents.slice(-50),
    updatedAt:   now,
  };

  // Merge with existing to preserve handledBy and createdAt
  const existing = convStore.get(conversationId) || {};
  const merged = {
    ...existing,
    ...record,
    handledBy:  existing.handledBy || null,
    createdAt:  existing.createdAt || now,
  };
  convStore.set(conversationId, merged);

  if (db) {
    try {
      await db.collection('agent_conversations').doc(conversationId).set(merged, { merge: true });
    } catch (e) {
      console.warn('Failed to persist conversation to Firestore:', e.message);
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
export function _clearAll() { convStore.clear(); }
