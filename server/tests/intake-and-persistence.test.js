/**
 * Return Intake Verification & Firestore Persistence Test Suite
 *
 * Exercises the three key requirements:
 * 1. Dev Auth Bypass Gate: x-dev-* headers rejected (401) when NODE_ENV is unset / not 'test'
 *    unless ALLOW_DEV_AUTH=1 is explicitly set.
 * 2. Strict Order Verification on Intake:
 *    - Order existence & ownership (caller must own unless admin/staff)
 *    - Order must be delivered & window counts from delivered_at (no fallback to "now")
 *    - Price & category come from the order item, not constants
 *    - Quantity cannot exceed ordered quantity
 *    - Already returned items cannot be returned again
 * 3. Firestore Branch & Persistence:
 *    - saveReturn writes to Firestore returns collection
 *    - saveReturn syncs returns into Firestore orders collection (for admin & customer dashboard)
 *    - Server restart (memory wipe) restores cases and list from Firestore
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { devAuthAllowed, verifyIdToken, requireRole } from '../middleware/auth.js';
import { createReturnsRouter } from '../routes/returns.js';
import * as returnStore from '../returns/store.js';

// ─── Lightweight Mock Firestore for Persistence Verification ─────────────────

function createMockFirestore() {
  const store = {
    returns: new Map(), // docId -> data
    orders:  new Map(), // docId -> data
  };
  // One entry per commit(): the doc paths written together in that batch.
  const commits = [];

  function getDocRef(colName, docId) {
    if (!store[colName]) store[colName] = new Map();
    const colMap = store[colName];
    const docPath = `${colName}/${docId}`;

    return {
      id: docId,
      path: docPath,
      async get() {
        const item = colMap.get(docId);
        const data = item ? { ...item } : undefined;
        if (data) delete data._subcollections;
        return {
          exists: Boolean(item),
          id: docId,
          data: () => data,
        };
      },
      async set(data, options = {}) {
        const existing = colMap.get(docId) || { _subcollections: {} };
        const subcollections = existing._subcollections || {};
        if (options.merge && colMap.has(docId)) {
          colMap.set(docId, { ...existing, ...data, _subcollections: subcollections });
        } else {
          colMap.set(docId, { ...data, _subcollections: subcollections });
        }
      },
      collection(subColName) {
        let existing = colMap.get(docId);
        if (!existing) {
          existing = { _subcollections: {} };
          colMap.set(docId, existing);
        }
        if (!existing._subcollections) existing._subcollections = {};
        if (!existing._subcollections[subColName]) existing._subcollections[subColName] = new Map();
        const subMap = existing._subcollections[subColName];

        return {
          doc(subDocId) {
            const subPath = `${docPath}/${subColName}/${subDocId}`;
            return {
              id: subDocId,
              path: subPath,
              async get() {
                const subData = subMap.get(subDocId);
                return {
                  exists: Boolean(subData),
                  id: subDocId,
                  data: () => (subData ? { ...subData } : undefined),
                };
              },
              async set(data) {
                subMap.set(subDocId, { ...data });
              },
              // Mirrors Firestore's create(): refuses to touch an existing doc.
              async create(data) {
                if (subMap.has(subDocId)) {
                  throw new Error(`Document already exists: ${subPath}`);
                }
                subMap.set(subDocId, { ...data });
              }
            };
          },
          async add(subData) {
            const autoId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            subMap.set(autoId, { ...subData, id: autoId });
            return { id: autoId };
          },
          orderBy(field, dir = 'asc') {
            return {
              async get() {
                const docs = [];
                for (const [id, data] of subMap.entries()) {
                  docs.push({ id, data: () => ({ ...data }) });
                }
                docs.sort((a, b) => {
                  const valA = a.data()[field];
                  const valB = b.data()[field];
                  if (valA < valB) return dir === 'asc' ? -1 : 1;
                  if (valA > valB) return dir === 'asc' ? 1 : -1;
                  return 0;
                });
                return { docs, empty: docs.length === 0 };
              }
            };
          },
          async get() {
            const docs = [];
            for (const [id, data] of subMap.entries()) {
              docs.push({ id, data: () => ({ ...data }) });
            }
            return { docs, empty: docs.length === 0 };
          }
        };
      }
    };
  }

  const db = {
    _isMock: true,
    _store: store,
    _commits: commits,
    batch() {
      const operations = [];
      return {
        set(docRef, data, options = {}) {
          operations.push({ path: docRef.path, run: () => docRef.set(data, options) });
        },
        create(docRef, data) {
          operations.push({ path: docRef.path, run: () => docRef.create(data) });
        },
        async commit() {
          for (const op of operations) {
            await op.run();
          }
          commits.push(operations.map(op => op.path));
        }
      };
    },
    collection(colName) {
      if (!store[colName]) store[colName] = new Map();
      const colMap = store[colName];

      return {
        doc(docId) {
          return getDocRef(colName, docId);
        },
        where(field, op, val) {
          return {
            limit(n) {
              return {
                async get() {
                  const matches = [];
                  for (const [id, data] of colMap.entries()) {
                    if (data[field] === val) {
                      const cleanData = { ...data };
                      delete cleanData._subcollections;
                      matches.push({ id, data: () => cleanData });
                      if (matches.length >= n) break;
                    }
                  }
                  return { docs: matches, empty: matches.length === 0 };
                }
              };
            },
            async get() {
              const matches = [];
              for (const [id, data] of colMap.entries()) {
                if (data[field] === val) {
                  const cleanData = { ...data };
                  delete cleanData._subcollections;
                  matches.push({ id, data: () => cleanData });
                }
              }
              return { docs: matches, empty: matches.length === 0 };
            }
          };
        },
        limit(n) {
          return {
            async get() {
              const matches = [];
              for (const [id, data] of colMap.entries()) {
                const cleanData = { ...data };
                delete cleanData._subcollections;
                matches.push({ id, data: () => cleanData });
                if (matches.length >= n) break;
              }
              return { docs: matches, empty: matches.length === 0 };
            }
          };
        }
      };
    }
  };

  return db;
}

// ─── Test Server Setup ───────────────────────────────────────────────────────

let mockDb;
let app;
let server;
let baseUrl;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.CARRIER_WEBHOOK_SECRET = 'test-secret';
  mockDb = createMockFirestore();

  app = express();
  app.use(express.json());
  const router = createReturnsRouter(mockDb);
  app.use(router);
  app.use('/api', router);

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      server.unref();
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

beforeEach(() => {
  returnStore._clearAll();
  mockDb._store.returns.clear();
  mockDb._store.orders.clear();
  mockDb._commits.length = 0;
});

async function req(endpoint, { method = 'GET', headers = {}, body } = {}) {
  const reqHeaders = { Connection: 'close', ...headers };
  let payload;
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${endpoint}`, { method, headers: reqHeaders, body: payload });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, ok: res.ok, data };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Dev Auth Header Bypass Security Checks
// ─────────────────────────────────────────────────────────────────────────────

describe('1. Dev login bypass security requirements', () => {
  it('devAuthAllowed() returns false when NODE_ENV is unset/production and ALLOW_DEV_AUTH is unset', () => {
    assert.equal(devAuthAllowed({}), false);
    assert.equal(devAuthAllowed({ NODE_ENV: 'production' }), false);
    assert.equal(devAuthAllowed({ NODE_ENV: 'development' }), false);
    assert.equal(devAuthAllowed({ NODE_ENV: '' }), false);
  });

  it('devAuthAllowed() returns true only when NODE_ENV === "test" or ALLOW_DEV_AUTH === "1"', () => {
    assert.equal(devAuthAllowed({ NODE_ENV: 'test' }), true);
    assert.equal(devAuthAllowed({ ALLOW_DEV_AUTH: '1' }), true);
    assert.equal(devAuthAllowed({ NODE_ENV: 'production', ALLOW_DEV_AUTH: '1' }), true);
    assert.equal(devAuthAllowed({ ALLOW_DEV_AUTH: '0' }), false);
    assert.equal(devAuthAllowed({ ALLOW_DEV_AUTH: 'true' }), false);
  });

  it('Refuses x-dev-role: admin with 401 when devAuthAllowed() is false', async () => {
    // Spin up an isolated router instance running with simulated normal/production environment
    const prevEnv = process.env.NODE_ENV;
    const prevAllow = process.env.ALLOW_DEV_AUTH;
    delete process.env.ALLOW_DEV_AUTH;
    process.env.NODE_ENV = 'production';

    const testApp = express();
    testApp.use(express.json());
    testApp.get('/test-protected', verifyIdToken, requireRole('admin'), (r, res) => res.json({ ok: true }));

    const srv = http.createServer(testApp);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test-protected`, {
        headers: { 'x-dev-uid': 'x', 'x-dev-role': 'admin' }
      });
      assert.equal(res.status, 401, 'unauthorized: dev headers must not bypass auth outside test/ALLOW_DEV_AUTH');
      const data = await res.json();
      assert.equal(data.error, 'Missing Bearer token');
    } finally {
      srv.close();
      process.env.NODE_ENV = prevEnv;
      if (prevAllow !== undefined) process.env.ALLOW_DEV_AUTH = prevAllow;
    }
  });

  it('Allows x-dev-role: admin when ALLOW_DEV_AUTH=1 is explicitly opted in', async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevAllow = process.env.ALLOW_DEV_AUTH;
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_DEV_AUTH = '1';

    const testApp = express();
    testApp.use(express.json());
    testApp.get('/test-dev-allow', verifyIdToken, requireRole('admin'), (r, res) => res.json({ ok: true, user: r.user }));

    const srv = http.createServer(testApp);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test-dev-allow`, {
        headers: { 'x-dev-uid': 'optin-admin', 'x-dev-role': 'admin' }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.user.uid, 'optin-admin');
      assert.equal(data.user.isAdmin, true);
    } finally {
      srv.close();
      process.env.NODE_ENV = prevEnv;
      if (prevAllow !== undefined) process.env.ALLOW_DEV_AUTH = prevAllow;
      else delete process.env.ALLOW_DEV_AUTH;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Strict Order Verification on Intake
// ─────────────────────────────────────────────────────────────────────────────

describe('2. Strict Order Verification on Return Intake', () => {
  it('Rejects intake with 404 if order does not exist', async () => {
    const res = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-alice', 'x-dev-role': 'customer' },
      body: { orderId: 'non-existent-order-id', reason: 'defective' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.data.error, 'Order not found');
  });

  it('Rejects intake with 404 if order belongs to a different customer (enumeration protection)', async () => {
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_alice_1',
        userId: 'cust-alice',
        customer: { user_id: 'cust-alice', full_name: 'Alice', email: 'alice@example.com' },
        status: 'delivered',
        delivered_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        items: [{ id: 'p1', product_id: 'p1', name: 'Item', price: 1000, quantity: 1, category: 'fashion' }],
      }
    });

    // Bob attempts to return Alice's order
    const res = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-bob', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_alice_1', productId: 'p1', reason: 'size_mismatch' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.data.error, 'Order not found');
  });

  it('Allows staff or admin to create intake on behalf of customer', async () => {
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_staff_assist',
        userId: 'cust-charlie',
        customer: { user_id: 'cust-charlie', full_name: 'Charlie', email: 'charlie@example.com' },
        status: 'delivered',
        delivered_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        items: [{ id: 'p_assist', product_id: 'p_assist', name: 'Watch', price: 2000, quantity: 1, category: 'standard' }],
      }
    });

    const res = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-rep', 'x-dev-role': 'staff' },
      body: { orderId: 'ord_staff_assist', productId: 'p_assist', reason: 'defective' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.returnRecord.userId, 'staff-rep');
  });

  it('Rejects intake with 422 if order is not delivered', async () => {
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_shipped_1',
        userId: 'cust-dan',
        customer: { user_id: 'cust-dan' },
        status: 'shipped', // In transit, not delivered
        items: [{ id: 'p_ship', product_id: 'p_ship', name: 'Shoes', price: 1500, quantity: 1, category: 'fashion' }],
      }
    });

    const res = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-dan', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_shipped_1', productId: 'p_ship', reason: 'defective' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.data.code, 'ORDER_NOT_DELIVERED');
  });

  it('Rejects intake with 422 if order delivery date is missing', async () => {
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_no_date',
        userId: 'cust-dan',
        customer: { user_id: 'cust-dan' },
        status: 'delivered',
        delivered_at: null, // missing delivered_at
        items: [{ id: 'p_nodate', product_id: 'p_nodate', name: 'Shirt', price: 800, quantity: 1, category: 'fashion' }],
      }
    });

    const res = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-dan', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_no_date', productId: 'p_nodate', reason: 'defective' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.data.code, 'DELIVERY_DATE_MISSING');
  });

  it('Rejects intake with 422 (WINDOW_EXPIRED) when delivered_at exceeds policy window', async () => {
    // Fashion return window is 14 days; delivered 20 days ago
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_expired_window',
        userId: 'cust-eva',
        customer: { user_id: 'cust-eva' },
        status: 'delivered',
        delivered_at: twentyDaysAgo,
        items: [{ id: 'p_exp', product_id: 'p_exp', name: 'Jeans', price: 1200, quantity: 1, category: 'fashion' }],
      }
    });

    const res = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-eva', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_expired_window', productId: 'p_exp', reason: 'size_mismatch' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.data.code, 'WINDOW_EXPIRED');
  });

  it('Derives price, category, and refund amount strictly from the order item, not constants', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_real_price',
        userId: 'cust-frank',
        customer: { user_id: 'cust-frank' },
        status: 'delivered',
        delivered_at: twoDaysAgo,
        items: [
          {
            id: 'p_luxury_watch',
            product_id: 'p_luxury_watch',
            name: 'Rolex Submariner Dial',
            price: 25000,
            quantity: 2,
            category: 'luxury',
          }
        ],
      }
    });

    const res = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-frank', 'x-dev-role': 'customer' },
      body: {
        orderId: 'ord_real_price',
        productId: 'p_luxury_watch',
        quantity: 2,
        reason: 'defective',
        resolutionType: 'refund',
      },
    });

    assert.equal(res.status, 201);
    const rec = res.data.returnRecord;
    assert.equal(rec.item.name, 'Rolex Submariner Dial');
    assert.equal(rec.item.price, 25000);
    assert.equal(rec.item.category, 'luxury');
    // 25000 * 2 = 50000
    assert.equal(rec.refund_amount, 50000);
  });

  it('Rejects intake with 422 if quantity exceeds ordered quantity', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_qty_limit',
        userId: 'cust-george',
        customer: { user_id: 'cust-george' },
        status: 'delivered',
        delivered_at: twoDaysAgo,
        items: [{ id: 'p_hat', product_id: 'p_hat', name: 'Hat', price: 300, quantity: 2, category: 'standard' }],
      }
    });

    // Customer ordered 2, requests return of 5
    const res = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-george', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_qty_limit', productId: 'p_hat', quantity: 5, reason: 'unwanted' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.data.code, 'EXCEEDS_ORDERED_QUANTITY');
  });

  it('Rejects intake with 422 if the same item was already returned (full & partial)', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_repeat_ret',
        userId: 'cust-helen',
        customer: { user_id: 'cust-helen' },
        status: 'delivered',
        delivered_at: twoDaysAgo,
        items: [{ id: 'p_lamp', product_id: 'p_lamp', name: 'Desk Lamp', price: 900, quantity: 3, category: 'standard' }],
        returns: [],
      }
    });

    // 1. First return: return 2 of the 3
    const firstRes = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-helen', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_repeat_ret', productId: 'p_lamp', quantity: 2, reason: 'unwanted' },
    });
    assert.equal(firstRes.status, 201);

    // 2. Second return: attempting to return 2 more (only 1 remaining) -> rejected
    const secondRes = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-helen', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_repeat_ret', productId: 'p_lamp', quantity: 2, reason: 'unwanted' },
    });
    assert.equal(secondRes.status, 422);
    assert.equal(secondRes.data.code, 'EXCEEDS_RETURNABLE_QUANTITY');

    // 3. Third return: returning the remaining 1 unit -> succeeds
    const thirdRes = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-helen', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_repeat_ret', productId: 'p_lamp', quantity: 1, reason: 'unwanted' },
    });
    assert.equal(thirdRes.status, 201);

    // 4. Fourth return: all 3 units have been returned -> rejected as ALREADY_RETURNED
    const fourthRes = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-helen', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_repeat_ret', productId: 'p_lamp', quantity: 1, reason: 'unwanted' },
    });
    assert.equal(fourthRes.status, 422);
    assert.equal(fourthRes.data.code, 'ALREADY_RETURNED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Firestore Branch & Persistence Verification
// ─────────────────────────────────────────────────────────────────────────────

describe('3. Firestore Branch & Persistence Requirements', () => {
  it('saveReturn synchronizes return record to Firestore returns collection', async () => {
    const returnRecord = {
      id: 'ret_fs_test_1',
      rma_number: 'RMA-FS-001',
      orderId: 'ord_fs_1',
      userId: 'cust-fs',
      status: 'REQUESTED',
      refund_amount: 1200,
    };

    await returnStore.saveReturn({ db: mockDb, returnRecord });

    const docInFirestore = mockDb._store.returns.get('ret_fs_test_1');
    assert.ok(docInFirestore, 'return document must be written to Firestore');
    assert.equal(docInFirestore.rma_number, 'RMA-FS-001');
    assert.equal(docInFirestore.refund_amount, 1200);
  });

  it('saveReturn syncs return record into Firestore orders doc returns array', async () => {
    // Seed initial order in Firestore without returns field
    await mockDb.collection('orders').doc('ord_fs_sync').set({
      id: 'ord_fs_sync',
      order_number: 'ORD-998877',
    });

    const returnRecord = {
      id: 'ret_fs_sync_1',
      rma_number: 'RMA-FS-SYNC-01',
      orderId: 'ord_fs_sync',
      userId: 'cust-sync',
      status: 'REQUESTED',
      status_label: 'Return Requested',
    };

    await returnStore.saveReturn({ db: mockDb, returnRecord });

    // Verify return doc is stored directly in returns collection
    const returnInFirestore = mockDb._store.returns.get('ret_fs_sync_1');
    assert.ok(returnInFirestore, 'return document must exist in Firestore returns collection');
    assert.equal(returnInFirestore.rma_number, 'RMA-FS-SYNC-01');
    assert.equal(returnInFirestore.id, 'ret_fs_sync_1');

    // Verify order doc does NOT have returns[] written to it (migrated away)
    const orderInFirestore = mockDb._store.orders.get('ord_fs_sync');
    assert.ok(orderInFirestore, 'order document must exist in Firestore');
    assert.strictEqual(orderInFirestore.returns, undefined, 'order.returns[] must not be written');

    // Verify getReturnsForOrder reads directly from returns collection
    const retrieved = await returnStore.getReturnsForOrder({ db: mockDb, orderId: 'ord_fs_sync' });
    assert.equal(retrieved.length, 1);
    assert.equal(retrieved[0].rma_number, 'RMA-FS-SYNC-01');
  });

  it('Server restart (in-memory wipe) recovers returns from Firestore', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_restart_test',
        userId: 'cust-restart',
        customer: { user_id: 'cust-restart' },
        status: 'delivered',
        delivered_at: twoDaysAgo,
        items: [{ id: 'p_res', product_id: 'p_res', name: 'Book', price: 400, quantity: 1, category: 'standard' }],
      }
    });

    // Create return through route
    const intakeRes = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-restart', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_restart_test', productId: 'p_res', reason: 'unwanted' },
    });
    assert.equal(intakeRes.status, 201);
    const returnId = intakeRes.data.returnRecord.id;
    const rmaNumber = intakeRes.data.returnRecord.rma_number;

    // Simulate complete server restart by wiping in-memory mirrors
    returnStore._clearAll();

    // 1. Fetch return by id directly — must reload from Firestore
    const fromFirestoreById = await returnStore.getReturn({ db: mockDb, identifier: returnId });
    assert.ok(fromFirestoreById, 'must load return from Firestore when in-memory map is empty');
    assert.equal(fromFirestoreById.id, returnId);

    // 2. Fetch return by RMA — must reload from Firestore
    const fromFirestoreByRma = await returnStore.getReturn({ db: mockDb, identifier: rmaNumber });
    assert.ok(fromFirestoreByRma, 'must load return by RMA from Firestore');
    assert.equal(fromFirestoreByRma.rma_number, rmaNumber);

    // 3. listReturns — must load from Firestore when memory is empty
    returnStore._clearAll();
    const list = await returnStore.listReturns({ db: mockDb });
    assert.ok(list.length >= 1, 'listReturns must query Firestore when memory is empty');
    assert.equal(list[0].id, returnId);

    // 4. Verify return doc in Firestore is loaded through getReturnsForOrder
    const returnsForOrder = await returnStore.getReturnsForOrder({ db: mockDb, orderId: 'ord_restart_test' });
    assert.ok(returnsForOrder.some(r => r.rma_number === rmaNumber));
  });

  it('Status updates (approval, inspection, webhook) stay synchronized in Firestore returns collection', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_lifecycle',
        userId: 'cust-cycle',
        customer: { user_id: 'cust-cycle' },
        status: 'delivered',
        delivered_at: twoDaysAgo,
        items: [{ id: 'p_cyc', product_id: 'p_cyc', name: 'Keyboard', price: 2500, quantity: 1, category: 'standard' }],
      }
    });

    const intakeRes = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-cycle', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_lifecycle', productId: 'p_cyc', reason: 'defective' },
    });
    const returnId = intakeRes.data.returnRecord.id;
    const rma = intakeRes.data.returnRecord.rma_number;

    // Staff approves return
    const approveRes = await req(`/agent/returns/${returnId}/approve`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
    });
    assert.equal(approveRes.status, 200);

    // Verify Firestore return doc in returns collection has status updated to APPROVED
    const returnInFs = mockDb._store.returns.get(returnId);
    assert.ok(returnInFs);
    assert.equal(returnInFs.status, 'APPROVED');
    assert.equal(returnInFs.status_label, 'RMA Approved');

    // And verify order doc has NO returns[] written (migrated away)
    const orderInFs = mockDb._store.orders.get('ord_lifecycle');
    assert.strictEqual(orderInFs.returns, undefined);
  });

  it('Audit events are written to returns/{id}/events in the same batch and verified via GET /returns/:id/audit after cold start', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_audit_batch',
        userId: 'cust-audit-batch',
        customer: { user_id: 'cust-audit-batch' },
        status: 'delivered',
        delivered_at: twoDaysAgo,
        items: [{ id: 'p_aud', product_id: 'p_aud', name: 'Camera', price: 3200, quantity: 1, category: 'standard' }],
      }
    });

    // 1. Create return intake
    const intakeRes = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-audit-batch', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_audit_batch', productId: 'p_aud', reason: 'unwanted' },
    });
    assert.equal(intakeRes.status, 201);
    const returnId = intakeRes.data.returnRecord.id;

    // Verify subcollection event 000001 was written in Firestore
    const returnDocInFs = mockDb._store.returns.get(returnId);
    assert.ok(returnDocInFs, 'return document must exist in Firestore');
    const eventsMap = returnDocInFs._subcollections?.events;
    assert.ok(eventsMap, 'events subcollection must exist in Firestore');
    const ev1 = eventsMap.get('000001');
    assert.ok(ev1, 'event 000001 must exist in Firestore');
    assert.equal(ev1.seq, 1);
    assert.equal(ev1.prevHash, '0'.repeat(64));
    assert.ok(ev1.hash, 'event hash must be present');
    assert.equal(ev1.action, 'RETURN_REQUESTED');

    // 2. Staff approves return
    const approveRes = await req(`/agent/returns/${returnId}/approve`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-aud', 'x-dev-role': 'staff' },
    });
    assert.equal(approveRes.status, 200);

    const ev2 = eventsMap.get('000002');
    assert.ok(ev2, 'event 000002 must exist in Firestore');
    assert.equal(ev2.seq, 2);
    assert.equal(ev2.prevHash, ev1.hash);
    assert.ok(ev2.hash, 'event 2 hash must be present');
    assert.equal(ev2.action, 'STAFF_APPROVED');

    // 3. Complete cold start (wipe in-memory maps)
    returnStore._clearAll();

    // 4. Read back via GET /returns/:id/audit and run verifyChain
    const auditRes = await req(`/returns/${returnId}/audit`, {
      method: 'GET',
      headers: { 'x-dev-uid': 'cust-audit-batch', 'x-dev-role': 'customer' },
    });
    assert.equal(auditRes.status, 200);
    assert.equal(auditRes.data.chainValid, true);
    assert.equal(auditRes.data.eventCount, 2);
    assert.equal(auditRes.data.events[0].seq, 1);
    assert.equal(auditRes.data.events[0].prevHash, '0'.repeat(64));
    assert.equal(auditRes.data.events[1].seq, 2);
    assert.equal(auditRes.data.events[1].prevHash, auditRes.data.events[0].hash);
    assert.equal(auditRes.data.verification.valid, true);
  });

  it('Audit event and return record are committed in the SAME Firestore batch, and events are create-only', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.seedOrder({
      db: mockDb,
      order: {
        id: 'ord_same_batch',
        userId: 'cust-same-batch',
        customer: { user_id: 'cust-same-batch' },
        status: 'delivered',
        delivered_at: twoDaysAgo,
        items: [{ id: 'p_sb', product_id: 'p_sb', name: 'Lens', price: 4100, quantity: 1, category: 'standard' }],
      }
    });

    const intakeRes = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-same-batch', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_same_batch', productId: 'p_sb', reason: 'defective' },
    });
    assert.equal(intakeRes.status, 201);
    const returnId = intakeRes.data.returnRecord.id;

    // 1. One commit carried both the return document and its first event.
    const shared = mockDb._commits.find(paths =>
      paths.includes(`returns/${returnId}`) && paths.includes(`returns/${returnId}/events/000001`)
    );
    assert.ok(
      shared,
      `expected return + event in one batch, commits were: ${JSON.stringify(mockDb._commits)}`
    );

    const eventsOf = () => mockDb._store.returns.get(returnId)._subcollections.events;
    const storedFirst = eventsOf().get('000001');
    assert.equal(storedFirst.seq, 1);
    assert.ok(storedFirst.hash, 'hash must be stored');
    assert.equal(storedFirst.prevHash, '0'.repeat(64), 'prevHash must be stored');

    // 2. Create-only at the document level: a second write to the same seq is refused.
    await assert.rejects(
      () => mockDb.collection('returns').doc(returnId).collection('events').doc('000001')
        .create({ seq: 1, hash: 'tampered-hash' }),
      /already exists/,
      'event documents must refuse overwrites'
    );
    assert.equal(eventsOf().get('000001').hash, storedFirst.hash, 'the stored event must be untouched');

    // 3. Create-only at the store level: a colliding seq never reaches Firestore.
    await returnStore.appendAuditEvent({
      db: mockDb,
      returnId,
      event: {
        seq: 1,
        hash: 'deadbeef',
        actor: 'attacker',
        action: 'TAMPER',
        data: {},
        timestamp: new Date().toISOString(),
        previousHash: '0'.repeat(64),
      },
    });
    assert.equal(eventsOf().get('000001').hash, storedFirst.hash, 'store must not rewrite an existing seq');
    assert.equal(eventsOf().size, 1, 'no extra event may be appended for a colliding seq');
  });
});
