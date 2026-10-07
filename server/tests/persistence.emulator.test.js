/**
 * PS-01 Firestore Persistence & Security Rules Integration Test (Emulator)
 *
 * Runs against Cloud Firestore Emulator via:
 *   firebase emulators:exec --only firestore "node --test tests/persistence.emulator.test.js"
 *
 * Flow:
 * 1. Intake a return via API backed by Admin SDK connected to Firestore Emulator.
 * 2. Staff approves the return via API.
 * 3. Cold start (memory wipe) and audit chain verification via GET /returns/:id/audit.
 * 4. Client SDK reads back under real firestore.rules:
 *    - Owner reads return & events (ALLOW)
 *    - Another customer is denied (DENY)
 *    - Client writes to returns collection are denied (DENY)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import * as returnStore from '../returns/store.js';
import { createReturnsRouter } from '../routes/returns.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIRESTORE_RULES_PATH = path.resolve(__dirname, '../../firestore.rules');

describe('Persistence & Security Rules Emulator Integration Test', () => {
  let testEnv;
  let adminDb;
  let server;
  let baseUrl;

  async function req(pathStr, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathStr, baseUrl);
      const bodyStr = options.body ? JSON.stringify(options.body) : null;
      const reqOpts = {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      };
      const clientReq = http.request(url, reqOpts, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      });
      clientReq.on('error', reject);
      if (bodyStr) clientReq.write(bodyStr);
      clientReq.end();
    });
  }

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

    const rules = fs.readFileSync(FIRESTORE_RULES_PATH, 'utf8');
    const host = process.env.FIRESTORE_EMULATOR_HOST.split(':')[0];
    const port = parseInt(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1], 10);

    testEnv = await initializeTestEnvironment({
      projectId: 'ps01-persistence-emulator-test',
      firestore: { rules, host, port },
    });

    if (!getApps().length) {
      initializeApp({ projectId: 'ps01-persistence-emulator-test' });
    }
    adminDb = getFirestore();

    const app = express();
    app.use(express.json());
    app.use(createReturnsRouter(adminDb));

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    returnStore._clearAll();
  });

  it('Full lifecycle: Intake -> Staff Approve -> Cold Start Audit Verify -> Client SDK Security Rules Isolation', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const orderId = 'ord_emu_test_1';
    const ownerUid = 'cust_alice_emu';
    const otherUid = 'cust_bob_emu';

    // 1. Seed order into Firestore via Admin SDK / store
    await returnStore.seedOrder({
      db: adminDb,
      order: {
        id: orderId,
        userId: ownerUid,
        customer: { user_id: ownerUid },
        status: 'delivered',
        delivered_at: twoDaysAgo,
        items: [{
          id: 'item_emu_1',
          product_id: 'item_emu_1',
          name: 'Wireless Mouse',
          price: 1500,
          quantity: 1,
          category: 'standard'
        }]
      }
    });

    // 2. Intake: Owner files a return via server API
    const intakeRes = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': ownerUid, 'x-dev-role': 'customer' },
      body: { orderId, productId: 'item_emu_1', reason: 'defective' }
    });
    assert.equal(intakeRes.status, 201, `Intake failed: ${JSON.stringify(intakeRes.data)}`);
    const returnId = intakeRes.data.returnRecord.id;
    assert.ok(returnId, 'returnId must be returned');

    // 3. Staff approves return via API
    const approveRes = await req(`/agent/returns/${returnId}/approve`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff_user_1', 'x-dev-role': 'staff' }
    });
    assert.equal(approveRes.status, 200, `Approve failed: ${JSON.stringify(approveRes.data)}`);
    assert.equal(approveRes.data.status, 'APPROVED');

    // 4. Cold Start: Wipe in-memory maps
    returnStore._clearAll();

    // 5. Audit Chain Verification: Read back via GET /returns/:id/audit after cold start
    const auditRes = await req(`/returns/${returnId}/audit`, {
      method: 'GET',
      headers: { 'x-dev-uid': ownerUid, 'x-dev-role': 'customer' }
    });
    assert.equal(auditRes.status, 200, `Audit read failed: ${JSON.stringify(auditRes.data)}`);
    assert.equal(auditRes.data.chainValid, true, 'Audit chain must be valid');
    assert.ok(auditRes.data.eventCount >= 2, 'Audit chain must contain at least 2 events');
    assert.equal(auditRes.data.verification.valid, true, 'verifyChain result must be valid');

    // 6. Client SDK Read Back under real firestore.rules
    const aliceDb = testEnv.authenticatedContext(ownerUid, { role: 'customer' }).firestore();
    const bobDb = testEnv.authenticatedContext(otherUid, { role: 'customer' }).firestore();

    // Owner reads return doc & events subcollection doc -> ALLOWED
    await assertSucceeds(aliceDb.collection('returns').doc(returnId).get());
    await assertSucceeds(aliceDb.collection('returns').doc(returnId).collection('events').doc('000001').get());

    // Another customer (Bob) reads return doc & events subcollection doc -> DENIED
    await assertFails(bobDb.collection('returns').doc(returnId).get());
    await assertFails(bobDb.collection('returns').doc(returnId).collection('events').doc('000001').get());

    // Client writes to returns collection -> DENIED for both owner and third party
    await assertFails(aliceDb.collection('returns').doc(returnId).update({ status: 'COMPLETED' }));
    await assertFails(aliceDb.collection('returns').doc('ret_unauthorized_create').set({ userId: ownerUid }));
    await assertFails(bobDb.collection('returns').doc(returnId).update({ status: 'COMPLETED' }));
  });
});
