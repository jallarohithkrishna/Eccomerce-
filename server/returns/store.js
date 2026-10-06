/**
 * Return Store — PS-01 Phase 4
 * In-memory store + Firestore synchronization for return records,
 * audit chains, and communication messages.
 */

import { GENESIS_HASH } from './audit.js';

// In-memory mirrors
const returnRecords = new Map();   // returnId -> ReturnRecord
const returnEvents  = new Map();   // returnId -> [AuditEvents]
const returnMessages = new Map();  // returnId -> [Messages]
const rmaToIdMap    = new Map();   // rmaNumber -> returnId

function shouldSync(db) {
  if (!db) return false;
  if (process.env.NODE_ENV === 'test' && !process.env.FIRESTORE_EMULATOR_HOST) return false;
  return true;
}

/**
 * Save or insert a return record.
 */
export async function saveReturn({ db, returnRecord }) {
  const id = returnRecord.id || returnRecord.returnId;
  if (!id) throw new Error('returnRecord requires an id');

  const now = new Date().toISOString();
  const existing = returnRecords.get(id) || {};
  const record = {
    ...existing,
    ...returnRecord,
    id,
    updatedAt: now,
    createdAt: existing.createdAt || returnRecord.createdAt || now,
  };

  returnRecords.set(id, record);
  if (record.rma_number) {
    rmaToIdMap.set(record.rma_number.toUpperCase(), id);
  }

  if (shouldSync(db)) {
    try {
      await db.collection('returns').doc(id).set(record, { merge: true });
    } catch (err) {
      console.warn(`Firestore saveReturn error (${id}):`, err.message);
    }
  }

  return record;
}

/**
 * Get return record by returnId or RMA number.
 */
export async function getReturn({ db, identifier }) {
  if (!identifier) return null;
  const clean = identifier.trim();

  // 1. Check in-memory by id
  let record = returnRecords.get(clean);

  // 2. Check in-memory by RMA
  if (!record) {
    const mappedId = rmaToIdMap.get(clean.toUpperCase());
    if (mappedId) record = returnRecords.get(mappedId);
  }

  if (record) return record;

  // 3. Fallback to Firestore
  if (shouldSync(db)) {
    try {
      const doc = await db.collection('returns').doc(clean).get();
      if (doc.exists) {
        const data = { id: doc.id, ...doc.data() };
        returnRecords.set(doc.id, data);
        if (data.rma_number) rmaToIdMap.set(data.rma_number.toUpperCase(), doc.id);
        return data;
      }

      // Query by rma_number
      const q = await db.collection('returns').where('rma_number', '==', clean).limit(1).get();
      if (!q.empty) {
        const d = q.docs[0];
        const data = { id: d.id, ...d.data() };
        returnRecords.set(d.id, data);
        rmaToIdMap.set(clean.toUpperCase(), d.id);
        return data;
      }
    } catch (err) {
      console.warn(`Firestore getReturn error (${clean}):`, err.message);
    }
  }

  return null;
}

/**
 * List returns with optional status filter and limit.
 */
export async function listReturns({ db, status, limitN = 50 }) {
  // If memory has records, filter memory
  let list = Array.from(returnRecords.values());

  if (list.length === 0 && shouldSync(db)) {
    try {
      let queryRef = db.collection('returns');
      if (status) {
        queryRef = queryRef.where('status', '==', status);
      }
      const snap = await queryRef.limit(limitN).get();
      list = snap.docs.map(doc => {
        const data = { id: doc.id, ...doc.data() };
        returnRecords.set(doc.id, data);
        return data;
      });
    } catch (err) {
      console.warn('Firestore listReturns error:', err.message);
    }
  }

  if (status) {
    list = list.filter(r => (r.status || '').toUpperCase() === status.toUpperCase());
  }

  return list.slice(0, limitN);
}

/**
 * Add an audit event to a return's chain.
 */
export async function appendAuditEvent({ db, returnId, event }) {
  const chain = returnEvents.get(returnId) || [];
  chain.push(event);
  returnEvents.set(returnId, chain);

  if (shouldSync(db)) {
    try {
      await db.collection('returns').doc(returnId).collection('events').add(event);
    } catch (err) {
      console.warn(`Firestore appendAuditEvent error (${returnId}):`, err.message);
    }
  }

  return chain;
}

/**
 * Get all audit events for a return case in chronological order.
 */
export async function getAuditEvents({ db, returnId }) {
  const mem = returnEvents.get(returnId);
  if (mem && mem.length > 0) return mem;

  if (shouldSync(db)) {
    try {
      const snap = await db.collection('returns').doc(returnId).collection('events')
        .orderBy('timestamp', 'asc')
        .get();
      const events = snap.docs.map(d => d.data());
      returnEvents.set(returnId, events);
      return events;
    } catch (err) {
      console.warn(`Firestore getAuditEvents error (${returnId}):`, err.message);
    }
  }

  return mem || [];
}

/**
 * Get last audit event hash for returnId, or GENESIS_HASH.
 */
export async function getLatestEventHash({ db, returnId }) {
  const events = await getAuditEvents({ db, returnId });
  if (events.length === 0) return GENESIS_HASH;
  return events[events.length - 1].hash;
}

/**
 * Add message to a return thread.
 */
export async function appendReturnMessage({ db, returnId, message }) {
  const msgs = returnMessages.get(returnId) || [];
  const msgRecord = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...message,
    timestamp: message.timestamp || new Date().toISOString(),
  };
  msgs.push(msgRecord);
  returnMessages.set(returnId, msgs);

  if (shouldSync(db)) {
    try {
      await db.collection('returns').doc(returnId).collection('messages').add(msgRecord);
    } catch (err) {
      console.warn(`Firestore appendReturnMessage error (${returnId}):`, err.message);
    }
  }

  return msgRecord;
}

/**
 * Get all messages for a return thread.
 */
export async function getReturnMessages({ db, returnId }) {
  const mem = returnMessages.get(returnId);
  if (mem && mem.length > 0) return mem;

  if (shouldSync(db)) {
    try {
      const snap = await db.collection('returns').doc(returnId).collection('messages')
        .orderBy('timestamp', 'asc')
        .get();
      const msgs = snap.docs.map(d => d.data());
      returnMessages.set(returnId, msgs);
      return msgs;
    } catch (err) {
      console.warn(`Firestore getReturnMessages error (${returnId}):`, err.message);
    }
  }

  return mem || [];
}

/** Reset in-memory maps (for testing) */
export function _clearAll() {
  returnRecords.clear();
  returnEvents.clear();
  returnMessages.clear();
  rmaToIdMap.clear();
}
