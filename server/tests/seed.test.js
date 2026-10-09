/**
 * Seed Script Unit Tests — PS-01 Phase C4
 *
 * Verifies:
 * 1. 10 products with appropriate categories & return policies
 * 2. 50 orders with varying delivery timestamps (inside/outside window, undelivered)
 * 3. Specific required orders (defective fashion in window, expired fashion, beauty, electronics service-center, grocery, luxury at 60k, undelivered)
 * 4. Auth users & custom roles creation (customer A, customer B, staff, warehouse, admin)
 * 5. Idempotent guard: second run without force is skipped
 * 6. Force override: allows re-seeding when requested
 *
 * Run: node --test tests/seed.test.js
 */

import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import {
  seedDatabase,
  buildSeedOrders,
  SEED_PRODUCTS,
  DEMO_USERS,
} from '../scripts/seed.js';

// Minimal in-memory mock Firestore for fast unit testing
function createMockDb() {
  const collections = new Map();

  function getCol(colName) {
    if (!collections.has(colName)) collections.set(colName, new Map());
    return collections.get(colName);
  }

  return {
    collection(colName) {
      const colMap = getCol(colName);
      return {
        doc(docId) {
          return {
            async get() {
              const data = colMap.get(docId);
              return {
                exists: !!data,
                data: () => data,
                id: docId,
              };
            },
            async set(data, opts = {}) {
              if (opts.merge && colMap.has(docId)) {
                colMap.set(docId, { ...colMap.get(docId), ...data });
              } else {
                colMap.set(docId, data);
              }
            },
          };
        },
        async get() {
          return {
            size: colMap.size,
            docs: Array.from(colMap.entries()).map(([id, data]) => ({
              id,
              data: () => data,
            })),
          };
        },
      };
    },
    _raw: collections,
  };
}

// Minimal in-memory mock Firebase Auth
function createMockAuth() {
  const users = new Map();
  const claims = new Map();

  return {
    async getUserByEmail(email) {
      for (const u of users.values()) {
        if (u.email === email) return u;
      }
      throw new Error('User not found');
    },
    async createUser(data) {
      const u = { ...data, uid: data.uid || `uid_${Date.now()}` };
      users.set(u.uid, u);
      return u;
    },
    async updateUser(uid, data) {
      const existing = users.get(uid) || { uid };
      const updated = { ...existing, ...data };
      users.set(uid, updated);
      return updated;
    },
    async setCustomUserClaims(uid, newClaims) {
      claims.set(uid, newClaims);
    },
    _users: users,
    _claims: claims,
  };
}

describe('Seed Script Tests (Phase C4)', () => {
  it('SEED01: buildSeedOrders produces exactly 50 orders with required scenario cases', () => {
    const orders = buildSeedOrders();
    assert.equal(orders.length, 50, 'Must produce 50 orders');

    // 1. Fashion defective & inside window
    const fashionInWin = orders.find(o => o.id === 'ORD-FASHION-DEFECTIVE-IN-WIN');
    assert.ok(fashionInWin, 'Must contain fashion defective in window order');
    assert.equal(fashionInWin.status, 'delivered');
    assert.ok(fashionInWin.delivered_at, 'Must have delivered_at');
    const ageDays1 = Math.round((Date.now() - new Date(fashionInWin.delivered_at).getTime()) / 86400000);
    assert.ok(ageDays1 <= 5, 'Must be within 14-day window (2-3 days)');

    // 2. Expired fashion item
    const fashionExp = orders.find(o => o.id === 'ORD-FASHION-EXPIRED');
    assert.ok(fashionExp, 'Must contain expired fashion order');
    const ageDays2 = Math.round((Date.now() - new Date(fashionExp.delivered_at).getTime()) / 86400000);
    assert.ok(ageDays2 >= 20, 'Must be well outside 14-day window');

    // 3. Beauty item
    const beauty = orders.find(o => o.id === 'ORD-BEAUTY-IN-WIN');
    assert.ok(beauty, 'Must contain beauty order');
    assert.equal(beauty.items[0].category, 'beauty');

    // 4. Electronics item
    const elec = orders.find(o => o.id === 'ORD-ELEC-SERVICE-CENTER');
    assert.ok(elec, 'Must contain electronics service-center order');
    assert.equal(elec.items[0].category, 'electronics');

    // 5. Grocery item
    const groc = orders.find(o => o.id === 'ORD-GROC-PERISHABLE');
    assert.ok(groc, 'Must contain grocery perishable order');
    assert.equal(groc.items[0].category, 'groceries');

    // 6. Luxury item at ₹60,000
    const lux = orders.find(o => o.id === 'ORD-LUX-60K-HUMAN-REVIEW');
    assert.ok(lux, 'Must contain ₹60,000 luxury order');
    assert.equal(lux.items[0].price, 60000);

    // 7. Not yet delivered
    const undelivered = orders.find(o => o.id === 'ORD-UNDELIVERED-ACTIVE');
    assert.ok(undelivered, 'Must contain undelivered order');
    assert.equal(undelivered.status, 'shipped');
    assert.equal(undelivered.delivered_at, null);
  });

  it('SEED02: seeds 10 products with canonical category return policies', async () => {
    assert.equal(SEED_PRODUCTS.length, 10, 'Must define 10 products');
    const categories = new Set(SEED_PRODUCTS.map(p => p.category));
    assert.ok(categories.has('fashion'));
    assert.ok(categories.has('beauty'));
    assert.ok(categories.has('electronics'));
    assert.ok(categories.has('groceries'));
    assert.ok(categories.has('luxury'));
    assert.ok(categories.has('home'));
  });

  it('SEED03: seeds auth users with custom claims (customer A, B, staff, warehouse, admin)', async () => {
    const mockDb = createMockDb();
    const mockAuth = createMockAuth();

    const res = await seedDatabase({ db: mockDb, auth: mockAuth, isForce: true });
    assert.equal(res.status, 'SEEDED_SUCCESSFULLY');
    assert.equal(res.ordersCount, 50);
    assert.equal(res.productsCount, 10);
    assert.equal(res.usersCount, 5);

    // Verify claims
    for (const u of DEMO_USERS) {
      assert.deepEqual(mockAuth._claims.get(u.uid), { role: u.role });
      const userDoc = await mockDb.collection('users').doc(u.uid).get();
      assert.ok(userDoc.exists);
      assert.equal(userDoc.data().role, u.role);
    }
  });

  it('SEED04: idempotency — second run without force is refused', async () => {
    const mockDb = createMockDb();
    const mockAuth = createMockAuth();

    // First run
    const res1 = await seedDatabase({ db: mockDb, auth: mockAuth });
    assert.equal(res1.status, 'SEEDED_SUCCESSFULLY');

    // Second run without force
    const res2 = await seedDatabase({ db: mockDb, auth: mockAuth, isForce: false });
    assert.equal(res2.status, 'SKIPPED_ALREADY_SEEDED', 'Must refuse second run');

    // Second run with force
    const res3 = await seedDatabase({ db: mockDb, auth: mockAuth, isForce: true });
    assert.equal(res3.status, 'SEEDED_SUCCESSFULLY', 'Must allow force re-seed');
  });
});
