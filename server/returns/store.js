/**
 * Return Store — PS-01 Phase 4
 * In-memory store + Firestore synchronization for return records,
 * audit chains, and communication messages.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { GENESIS_HASH } from './audit.js';
import { generateRma } from './rma.js';

// In-memory mirrors
const returnRecords = new Map();   // returnId -> ReturnRecord
const returnEvents  = new Map();   // returnId -> [AuditEvents]
const returnMessages = new Map();  // returnId -> [Messages]
const rmaToIdMap    = new Map();   // rmaNumber -> returnId
const orderRecords  = new Map();   // orderId -> OrderRecord

export function shouldSync(db) {
  if (!db) return false;
  if (db._isMock || db.isMock) return true;
  if (process.env.NODE_ENV === 'test' && !process.env.FIRESTORE_EMULATOR_HOST) return false;
  return true;
}

/**
 * Seed or save an order into in-memory store and Firestore (when syncing).
 */
export async function seedOrder({ db, order } = {}) {
  if (!order || !order.id) throw new Error('seedOrder requires an order with an id');
  const record = {
    ...order,
    returns: Array.isArray(order.returns) ? [...order.returns] : [],
  };
  orderRecords.set(order.id, record);

  if (shouldSync(db)) {
    try {
      await db.collection('orders').doc(order.id).set(record, { merge: true });
    } catch (err) {
      console.warn(`Firestore seedOrder error (${order.id}):`, err.message);
    }
  }

  return record;
}

/**
 * Update order status and set delivered_at when status is delivered.
 */
export async function updateOrderStatus({ db, orderId, status, deliveredAt } = {}) {
  if (!orderId) return null;
  const cleanId = String(orderId).trim();
  let record = orderRecords.get(cleanId);
  if (!record && shouldSync(db)) {
    record = await getOrder({ db, orderId: cleanId });
  }
  record = record || { id: cleanId };

  const now = new Date().toISOString();
  record.status = status;
  record.updatedAt = now;

  let serverTimestamp = deliveredAt;
  if (String(status).toLowerCase() === 'delivered') {
    if (!deliveredAt) {
      serverTimestamp = (shouldSync(db) && db && typeof FieldValue !== 'undefined' && FieldValue.serverTimestamp)
        ? FieldValue.serverTimestamp()
        : now;
    }
    record.delivered_at = typeof serverTimestamp === 'string' ? serverTimestamp : (record.delivered_at || now);
  }

  orderRecords.set(cleanId, record);

  if (shouldSync(db)) {
    try {
      const updateData = { status, updatedAt: now };
      if (String(status).toLowerCase() === 'delivered') {
        updateData.delivered_at = serverTimestamp || now;
      }
      await db.collection('orders').doc(cleanId).set(updateData, { merge: true });
    } catch (err) {
      console.warn(`Firestore updateOrderStatus error (${cleanId}):`, err.message);
    }
  }

  return record;
}

/**
 * Get order by ID from in-memory store or Firestore.
 */
export async function getOrder({ db, orderId }) {
  if (!orderId) return null;
  const cleanId = String(orderId).trim();

  // 1. Check in-memory store first
  const mem = orderRecords.get(cleanId);
  if (mem) return mem;

  // 2. Query Firestore if syncing
  if (shouldSync(db)) {
    try {
      const snap = await db.collection('orders').doc(cleanId).get();
      if (snap.exists) {
        const data = { id: snap.id, ...snap.data() };
        orderRecords.set(cleanId, data);
        return data;
      }
    } catch (err) {
      console.warn(`Firestore getOrder error (${cleanId}):`, err.message);
    }
  }

  return null;
}

/**
 * Get all returns filed for a specific order.
 */
export async function getReturnsForOrder({ db, orderId }) {
  if (!orderId) return [];
  const cleanId = String(orderId).trim();
  const results = new Map();

  // 1. From in-memory returnRecords
  for (const ret of returnRecords.values()) {
    if (String(ret.orderId || ret.order_id) === cleanId) {
      results.set(ret.id, ret);
    }
  }

  // 2. From in-memory order record's returns array
  const order = orderRecords.get(cleanId);
  if (order && Array.isArray(order.returns)) {
    for (const r of order.returns) {
      const rid = r.id || r.returnId || r.rma_number;
      if (rid && !results.has(rid)) results.set(rid, r);
    }
  }

  // 3. From Firestore returns collection if syncing
  if (shouldSync(db)) {
    try {
      const q = await db.collection('returns').where('orderId', '==', cleanId).get();
      if (!q.empty) {
        q.docs.forEach(doc => {
          const data = { id: doc.id, ...doc.data() };
          if (!results.has(doc.id)) results.set(doc.id, data);
        });
      }
    } catch (err) {
      console.warn(`Firestore getReturnsForOrder error (${cleanId}):`, err.message);
    }
  }

  return Array.from(results.values());
}

/**
 * Is this RMA number already taken? Checked in memory and (when syncing) in
 * Firestore, so a freshly minted code can be proven unique before it is stored.
 */
export async function isRmaTaken({ db, rma }) {
  if (!rma) return false;
  const key = String(rma).toUpperCase();
  if (rmaToIdMap.has(key)) return true;

  if (shouldSync(db)) {
    try {
      const q = await db.collection('returns').where('rma_number', '==', rma).limit(1).get();
      if (!q.empty) return true;
    } catch (err) {
      console.warn(`Firestore isRmaTaken error (${rma}):`, err.message);
    }
  }
  return false;
}

/**
 * Mint an RMA number that is both cryptographically random and unique.
 * @returns {Promise<string>}
 */
export async function generateUniqueRma({ db, maxAttempts = 10 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rma = generateRma();
    if (!(await isRmaTaken({ db, rma }))) return rma;
  }
  throw new Error(`Could not generate a unique RMA number after ${maxAttempts} attempts`);
}

/**
 * Save or insert a return record. Syncs to both returns and orders collections.
 * If an audit event is supplied, it is written in the same Firestore batch as the return write.
 */
export async function saveReturn({ db, returnRecord, event }) {
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

  // Handle audit event if passed (create-only: a seq is written exactly once)
  let eventRecord = null;
  if (event) {
    let chain = returnEvents.get(id);
    if (!chain && shouldSync(db)) {
      chain = await getAuditEvents({ db, returnId: id });
    }
    chain = chain || [];
    const seq = event.seq || (chain.length + 1);
    const prevHash = event.prevHash || event.previousHash || (chain.length > 0 ? chain[chain.length - 1].hash : GENESIS_HASH);

    const occupied = chain.find(e => Number(e.seq) === Number(seq)) ||
                     chain.find(e => e.hash === event.hash);
    if (occupied) {
      // Append-only log: an event already owns this slot — never overwrite it.
      eventRecord = null;
    } else {
      eventRecord = {
        ...event,
        returnId: id,
        seq,
        prevHash,
        previousHash: prevHash,
      };
      chain.push(eventRecord);
    }
    returnEvents.set(id, chain);
  }

  // 1. Sync to in-memory order record if present
  const orderId = record.orderId || record.order_id;
  if (orderId && orderRecords.has(orderId)) {
    const order = orderRecords.get(orderId);
    const existingReturns = Array.isArray(order.returns) ? [...order.returns] : [];
    const idx = existingReturns.findIndex(r =>
      (r.rma_number && record.rma_number && r.rma_number.toUpperCase() === record.rma_number.toUpperCase()) ||
      (r.id && r.id === id) ||
      (r.returnId && r.returnId === id)
    );
    if (idx >= 0) {
      existingReturns[idx] = { ...existingReturns[idx], ...record };
    } else {
      existingReturns.push(record);
    }
    order.returns = existingReturns;
    orderRecords.set(orderId, order);
  }

  // 2. Sync to Firestore (both `returns` and `orders` collections, and `returns/{id}/events` in same batch)
  if (shouldSync(db)) {
    try {
      if (typeof db.batch === 'function') {
        const batch = db.batch();
        const returnRef = db.collection('returns').doc(id);
        batch.set(returnRef, record, { merge: true });

        if (eventRecord) {
          const seqStr = String(eventRecord.seq).padStart(6, '0');
          const eventRef = returnRef.collection('events').doc(seqStr);
          // Create-only: an audit event is never updated once written.
          if (typeof batch.create === 'function') batch.create(eventRef, eventRecord);
          else batch.set(eventRef, eventRecord);
        }
        await batch.commit();
      } else {
        await db.collection('returns').doc(id).set(record, { merge: true });
        if (eventRecord) {
          const seqStr = String(eventRecord.seq).padStart(6, '0');
          const eventRef = db.collection('returns').doc(id).collection('events').doc(seqStr);
          if (typeof eventRef.create === 'function') await eventRef.create(eventRecord);
          else await eventRef.set(eventRecord);
        }
      }
    } catch (err) {
      console.warn(`Firestore saveReturn error (${id}):`, err.message);
    }

    if (orderId) {
      try {
        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        if (orderSnap.exists) {
          const orderData = orderSnap.data() || {};
          const existingReturns = Array.isArray(orderData.returns) ? [...orderData.returns] : [];
          const idx = existingReturns.findIndex(r =>
            (r.rma_number && record.rma_number && r.rma_number.toUpperCase() === record.rma_number.toUpperCase()) ||
            (r.id && r.id === id) ||
            (r.returnId && r.returnId === id)
          );
          if (idx >= 0) {
            existingReturns[idx] = { ...existingReturns[idx], ...record };
          } else {
            existingReturns.push(record);
          }
          await orderRef.set({ returns: existingReturns }, { merge: true });
        }
      } catch (err) {
        console.warn(`Firestore sync order returns error (${orderId}):`, err.message);
      }
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
  let chain = returnEvents.get(returnId);
  if (!chain && shouldSync(db)) {
    chain = await getAuditEvents({ db, returnId });
  }
  chain = chain || [];
  const seq = event.seq || (chain.length + 1);
  const prevHash = event.prevHash || event.previousHash || (chain.length > 0 ? chain[chain.length - 1].hash : GENESIS_HASH);

  // Create-only guard: a seq (or a hash) that already exists is never rewritten.
  const occupied = chain.find(e => Number(e.seq) === Number(seq)) ||
                   chain.find(e => e.hash === event.hash);
  if (occupied) return chain;

  const eventRecord = {
    ...event,
    returnId,
    seq,
    prevHash,
    previousHash: prevHash,
  };
  chain.push(eventRecord);
  returnEvents.set(returnId, chain);

  if (shouldSync(db)) {
    try {
      const seqStr = String(seq).padStart(6, '0');
      const eventRef = db.collection('returns').doc(returnId).collection('events').doc(seqStr);
      if (typeof eventRef.create === 'function') await eventRef.create(eventRecord);
      else await eventRef.set(eventRecord);
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
      let snap;
      try {
        snap = await db.collection('returns').doc(returnId).collection('events')
          .orderBy('seq', 'asc')
          .get();
      } catch {
        snap = await db.collection('returns').doc(returnId).collection('events')
          .orderBy('timestamp', 'asc')
          .get();
      }
      const events = snap.docs.map(d => {
        const data = d.data();
        return {
          ...data,
          previousHash: data.previousHash || data.prevHash,
          prevHash: data.prevHash || data.previousHash,
        };
      });
      // Sort in-memory as safety net
      events.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
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
  orderRecords.clear();
}
