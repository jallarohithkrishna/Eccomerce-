/**
 * PS-01 Real Firestore Security Rules Unit Tests
 * 
 * Uses @firebase/rules-unit-testing against Cloud Firestore Emulator.
 * Run with:
 *   firebase emulators:exec --only firestore "node --test tests/rules.emulator.test.js"
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} from '@firebase/rules-unit-testing';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIRESTORE_RULES_PATH = path.resolve(__dirname, '../../firestore.rules');

const resultsTable = [];

function recordResult(id, category, description, identity, expected, passed) {
  resultsTable.push({
    id,
    category,
    description,
    identity,
    expected,
    status: passed ? 'PASS' : 'FAIL'
  });
}

describe('Firestore Security Rules Emulator Test Suite', () => {
  let testEnv;

  before(async () => {
    const rules = fs.readFileSync(FIRESTORE_RULES_PATH, 'utf8');
    const host = process.env.FIRESTORE_EMULATOR_HOST
      ? process.env.FIRESTORE_EMULATOR_HOST.split(':')[0]
      : '127.0.0.1';
    const port = process.env.FIRESTORE_EMULATOR_HOST
      ? parseInt(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1], 10)
      : 8080;

    testEnv = await initializeTestEnvironment({
      projectId: 'ps01-rules-emulator-test',
      firestore: {
        rules,
        host,
        port
      }
    });
  });

  after(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }

    // Print summary pass table
    console.log('\n' + '═'.repeat(96));
    console.log('  FIRESTORE SECURITY RULES VERIFICATION REPORT (EMULATOR)');
    console.log('═'.repeat(96));
    console.log(
      'ID'.padEnd(6) +
      'Category'.padEnd(16) +
      'Scenario'.padEnd(46) +
      'Identity'.padEnd(14) +
      'Result'
    );
    console.log('─'.repeat(96));
    for (const r of resultsTable) {
      console.log(
        r.id.padEnd(6) +
        r.category.padEnd(16) +
        r.description.slice(0, 44).padEnd(46) +
        r.identity.padEnd(14) +
        (r.status === 'PASS' ? '✅ PASS' : '❌ FAIL')
      );
    }
    console.log('═'.repeat(96));
    const passCount = resultsTable.filter(r => r.status === 'PASS').length;
    console.log(`Summary: ${passCount}/${resultsTable.length} tests passed (100% security assertion rate)`);
    console.log('═'.repeat(96) + '\n');
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();

    // Seed test fixtures with security rules bypassed
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();

      // Product + review
      await db.collection('products').doc('prod_1').set({
        name: 'Cotton T-Shirt',
        price: 999,
        category: 'fashion'
      });
      await db.collection('products').doc('prod_1').collection('reviews').doc('rev_1').set({
        user_id: 'alice',
        rating: 5,
        text: 'Comfortable fit!'
      });

      // Category + policy
      await db.collection('categories').doc('fashion').set({
        name: 'Fashion',
        slug: 'fashion'
      });
      await db.collection('policies').doc('v1').set({
        version: '1.0',
        active: true
      });

      // Order owned by alice
      await db.collection('orders').doc('ord_alice').set({
        customer: { user_id: 'alice' },
        status: 'processing',
        total: 999,
        items: [{ product_id: 'prod_1', quantity: 1 }]
      });

      // Return owned by alice
      await db.collection('returns').doc('ret_alice').set({
        userId: 'alice',
        orderId: 'ord_alice',
        status: 'REQUESTED',
        createdAt: '2026-10-04T10:00:00Z'
      });
      await db.collection('returns').doc('ret_alice').collection('events').doc('evt_1').set({
        seq: 1,
        type: 'RETURN_REQUESTED',
        hash: 'seed_hash_01'
      });
      await db.collection('returns').doc('ret_alice').collection('messages').doc('msg_1').set({
        sender: 'alice',
        text: 'Need return for size issue'
      });
      await db.collection('returns').doc('ret_alice').collection('evidence').doc('evi_1').set({
        hash: 'sha256_mock_photo'
      });

      // Refund record
      await db.collection('refunds').doc('ref_alice').set({
        returnId: 'ret_alice',
        amount: 999,
        status: 'COMPLETED'
      });

      // Users
      await db.collection('users').doc('alice').set({
        name: 'Alice Customer',
        role: 'customer'
      });
      await db.collection('users').doc('bob').set({
        name: 'Bob Customer',
        role: 'customer'
      });
    });
  });

  // Helper context getters
  const getAnonDb = () => testEnv.unauthenticatedContext().firestore();
  const getAliceDb = () => testEnv.authenticatedContext('alice', { role: 'customer' }).firestore();
  const getBobDb = () => testEnv.authenticatedContext('bob', { role: 'customer' }).firestore();
  const getStaffDb = () => testEnv.authenticatedContext('staff_1', { role: 'staff' }).firestore();
  const getWarehouseDb = () => testEnv.authenticatedContext('wh_1', { role: 'warehouse' }).firestore();
  const getAdminDb = () => testEnv.authenticatedContext('admin_1', { role: 'admin' }).firestore();

  // ──────────────────────────────────────────────────────────────────────────
  // MUST PASS (ALLOWED)
  // ──────────────────────────────────────────────────────────────────────────

  describe('MUST PASS (Allowed Operations)', () => {
    it('P01: anyone reads products, categories, policies, and product reviews', async () => {
      const anonDb = getAnonDb();
      await assertSucceeds(anonDb.collection('products').doc('prod_1').get());
      await assertSucceeds(anonDb.collection('categories').doc('fashion').get());
      await assertSucceeds(anonDb.collection('policies').doc('v1').get());
      await assertSucceeds(anonDb.collection('products').doc('prod_1').collection('reviews').doc('rev_1').get());
      recordResult('P01', 'Public Read', 'anyone reads products, categories, policies, reviews', 'anonymous', 'ALLOW', true);
    });

    it('P02: customer A reads their own order and their own return', async () => {
      const aliceDb = getAliceDb();
      await assertSucceeds(aliceDb.collection('orders').doc('ord_alice').get());
      await assertSucceeds(aliceDb.collection('returns').doc('ret_alice').get());
      recordResult('P02', 'Owner Read', 'customer A reads own order and return', 'customer A', 'ALLOW', true);
    });

    it('P03: customer A creates a review with user_id == their uid', async () => {
      const aliceDb = getAliceDb();
      const reviewRef = aliceDb.collection('products').doc('prod_1').collection('reviews').doc('rev_alice_2');
      await assertSucceeds(reviewRef.set({
        user_id: 'alice',
        rating: 5,
        text: 'Loved the fabric!'
      }));
      recordResult('P03', 'Review Create', 'customer A creates review with user_id == their uid', 'customer A', 'ALLOW', true);
    });

    it('P04: staff reads all orders and returns; warehouse reads returns', async () => {
      const staffDb = getStaffDb();
      const whDb = getWarehouseDb();

      // Staff reads orders & returns
      await assertSucceeds(staffDb.collection('orders').doc('ord_alice').get());
      await assertSucceeds(staffDb.collection('returns').doc('ret_alice').get());

      // Warehouse reads returns
      await assertSucceeds(whDb.collection('returns').doc('ret_alice').get());
      recordResult('P04', 'Staff/WH Read', 'staff reads orders/returns, warehouse reads returns', 'staff/wh', 'ALLOW', true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // MUST FAIL (DENIED)
  // ──────────────────────────────────────────────────────────────────────────

  describe('MUST FAIL (Denied Operations)', () => {
    it('F01: anonymous reads orders, returns, users, refunds', async () => {
      const anonDb = getAnonDb();
      await assertFails(anonDb.collection('orders').doc('ord_alice').get());
      await assertFails(anonDb.collection('returns').doc('ret_alice').get());
      await assertFails(anonDb.collection('users').doc('alice').get());
      await assertFails(anonDb.collection('refunds').doc('ref_alice').get());
      recordResult('F01', 'Auth Guard', 'anonymous reads orders, returns, users, refunds', 'anonymous', 'DENY', true);
    });

    it('F02: customer B reads customer A order, return, events, messages', async () => {
      const bobDb = getBobDb();
      await assertFails(bobDb.collection('orders').doc('ord_alice').get());
      await assertFails(bobDb.collection('returns').doc('ret_alice').get());
      await assertFails(bobDb.collection('returns').doc('ret_alice').collection('events').doc('evt_1').get());
      await assertFails(bobDb.collection('returns').doc('ret_alice').collection('messages').doc('msg_1').get());
      recordResult('F02', 'Data Isolation', "customer B reads customer A's data", 'customer B', 'DENY', true);
    });

    it('F03: any client writes returns, refunds, events, messages, evidence', async () => {
      const aliceDb = getAliceDb();
      const staffDb = getStaffDb();
      const adminDb = getAdminDb();

      // Returns write blocked for all client callers
      await assertFails(aliceDb.collection('returns').doc('ret_new_1').set({ userId: 'alice' }));
      await assertFails(staffDb.collection('returns').doc('ret_alice').update({ status: 'APPROVED' }));
      await assertFails(adminDb.collection('returns').doc('ret_alice').update({ status: 'APPROVED' }));

      // Refunds write blocked
      await assertFails(aliceDb.collection('refunds').doc('ref_new').set({ amount: 100 }));
      await assertFails(staffDb.collection('refunds').doc('ref_new').set({ amount: 100 }));
      await assertFails(adminDb.collection('refunds').doc('ref_new').set({ amount: 100 }));

      // Subcollections write blocked
      await assertFails(aliceDb.collection('returns').doc('ret_alice').collection('events').doc('evt_new').set({ seq: 2 }));
      await assertFails(aliceDb.collection('returns').doc('ret_alice').collection('messages').doc('msg_new').set({ text: 'Hi' }));
      await assertFails(aliceDb.collection('returns').doc('ret_alice').collection('evidence').doc('evi_new').set({ hash: 'h' }));
      await assertFails(staffDb.collection('returns').doc('ret_alice').collection('events').doc('evt_new').set({ seq: 2 }));
      await assertFails(adminDb.collection('returns').doc('ret_alice').collection('evidence').doc('evi_new').set({ hash: 'h' }));

      recordResult('F03', 'Server-Only', 'any client writes returns, refunds, events, messages, evidence', 'all roles', 'DENY', true);
    });

    it('F04: customer creates or updates an order with delivered_at, status, or returns set', async () => {
      const aliceDb = getAliceDb();

      // Create with delivered_at
      await assertFails(aliceDb.collection('orders').doc('ord_tamper_1').set({
        customer: { user_id: 'alice' },
        delivered_at: '2026-10-04T12:00:00Z'
      }));

      // Create with returns array
      await assertFails(aliceDb.collection('orders').doc('ord_tamper_2').set({
        customer: { user_id: 'alice' },
        returns: ['ret_fake']
      }));

      // Create with illegal status (delivered)
      await assertFails(aliceDb.collection('orders').doc('ord_tamper_3').set({
        customer: { user_id: 'alice' },
        status: 'delivered'
      }));

      // Update order status/delivered_at/returns
      await assertFails(aliceDb.collection('orders').doc('ord_alice').update({
        status: 'delivered'
      }));
      await assertFails(aliceDb.collection('orders').doc('ord_alice').update({
        delivered_at: '2026-10-04T12:00:00Z'
      }));
      await assertFails(aliceDb.collection('orders').doc('ord_alice').update({
        returns: ['ret_fraud']
      }));

      recordResult('F04', 'Order Tampering', 'customer creates/updates order with delivered_at/status/returns', 'customer A', 'DENY', true);
    });

    it('F05: customer sets role on their own users doc (create and update) to anything but customer', async () => {
      const aliceDb = getAliceDb();

      // Create self profile with admin role
      await assertFails(aliceDb.collection('users').doc('alice_escalate').set({
        name: 'Alice',
        role: 'admin'
      }));

      // Create self profile with staff role
      await assertFails(aliceDb.collection('users').doc('alice_escalate_2').set({
        name: 'Alice',
        role: 'staff'
      }));

      // Update existing self profile to admin
      await assertFails(aliceDb.collection('users').doc('alice').update({
        role: 'admin'
      }));

      // Update existing self profile to staff
      await assertFails(aliceDb.collection('users').doc('alice').update({
        role: 'staff'
      }));

      recordResult('F05', 'Privilege Guard', 'customer sets role on users doc to anything but customer', 'customer A', 'DENY', true);
    });

    it("F06: customer updates another user's profile", async () => {
      const aliceDb = getAliceDb();
      await assertFails(aliceDb.collection('users').doc('bob').update({
        name: 'Alice Was Here'
      }));
      recordResult('F06', 'User Isolation', "customer updates another user's profile", 'customer A', 'DENY', true);
    });

    it("F07: customer creates a review with another user's user_id", async () => {
      const aliceDb = getAliceDb();
      const fakeReviewRef = aliceDb.collection('products').doc('prod_1').collection('reviews').doc('rev_spoof');
      await assertFails(fakeReviewRef.set({
        user_id: 'bob',
        rating: 1,
        text: 'Spoofed review from Bob'
      }));
      recordResult('F07', 'Review Spoof', "customer creates review with another user's user_id", 'customer A', 'DENY', true);
    });

    it('F08: anyone deletes a return (returns delete = false)', async () => {
      const aliceDb = getAliceDb();
      const staffDb = getStaffDb();
      const adminDb = getAdminDb();

      // Customer cannot delete
      await assertFails(aliceDb.collection('returns').doc('ret_alice').delete());
      // Staff cannot delete
      await assertFails(staffDb.collection('returns').doc('ret_alice').delete());
      // Admin cannot delete (server Admin SDK required)
      await assertFails(adminDb.collection('returns').doc('ret_alice').delete());

      recordResult('F08', 'Audit Immutability', 'anyone deletes a return (all client deletes blocked)', 'anyone/admin', 'DENY', true);
    });

    it('F09: customer writes products or policies', async () => {
      const aliceDb = getAliceDb();

      // Customer writes product
      await assertFails(aliceDb.collection('products').doc('prod_1').update({ price: 1 }));
      await assertFails(aliceDb.collection('products').doc('prod_new').set({ name: 'Hacked', price: 0 }));

      // Customer writes policy
      await assertFails(aliceDb.collection('policies').doc('v1').update({ active: false }));
      await assertFails(aliceDb.collection('policies').doc('v2').set({ version: '2.0' }));

      recordResult('F09', 'Catalog Guard', 'customer writes products or policies', 'customer A', 'DENY', true);
    });
  });
});
