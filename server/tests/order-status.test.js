/**
 * ORDER STATUS Tests — PS-01 Phase C2
 * Covers: PATCH /api/orders/:id/status
 *   OS01 – only legal statuses accepted
 *   OS02 – backward move rejected (shipped → processing)
 *   OS03 – delivered is final (cannot move away)
 *   OS04 – cancelled is final (cannot move away)
 *   OS05 – double-delivered: delivered_at is set once and never overwritten
 *   OS06 – customer role is rejected (403)
 *   OS07 – no auth is rejected (401)
 *   OS08 – happy-path forward transitions
 *   OS09 – err.message is hidden from response body when NODE_ENV != test
 *
 * Run: node --test tests/order-status.test.js
 */

import { strict as assert } from 'assert';
import { describe, it, before, after, beforeEach } from 'node:test';
import http from 'node:http';
import { app } from '../index.js';
import * as returnStore from '../returns/store.js';

let server;
let baseUrl;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.CARRIER_WEBHOOK_SECRET = process.env.CARRIER_WEBHOOK_SECRET || 'test-carrier-secret';
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
});

// ─── Helper ──────────────────────────────────────────────────────────────────

async function patch(orderId, status, role = 'staff', uid = 'staff-1') {
  const res = await fetch(`${baseUrl}/api/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-dev-uid': uid,
      'x-dev-role': role,
    },
    body: JSON.stringify({ status }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function seedOrder(orderId, status = 'pending') {
  await returnStore.seedOrder({ db: null, order: { id: orderId, status } });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PATCH /api/orders/:id/status — Order Status Enforcement', () => {
  it('OS01: rejects an unknown status string (400)', async () => {
    await seedOrder('ord_os01', 'pending');
    const { status, data } = await patch('ord_os01', 'flying', 'staff');
    assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(data)}`);
    assert.ok(data.error, 'error field must be present');
    assert.equal(data.code, 'ORDER_STATUS_INVALID');
  });

  it('OS02: rejects a backward move shipped → processing (400)', async () => {
    await seedOrder('ord_os02', 'shipped');
    const { status, data } = await patch('ord_os02', 'processing', 'staff');
    assert.equal(status, 400);
    assert.equal(data.code, 'ORDER_STATUS_BACKWARD');
  });

  it('OS02b: rejects a backward move delivered → shipped (guarded by final-state rule)', async () => {
    await seedOrder('ord_os02b', 'delivered');
    const { status, data } = await patch('ord_os02b', 'shipped', 'staff');
    assert.equal(status, 400);
    assert.equal(data.code, 'ORDER_STATUS_FINAL');
  });

  it('OS03: delivered is final — cannot move to any other status', async () => {
    await seedOrder('ord_os03', 'delivered');
    const { status, data } = await patch('ord_os03', 'processing', 'staff');
    assert.equal(status, 400);
    assert.equal(data.code, 'ORDER_STATUS_FINAL');
  });

  it('OS04: cancelled is final — cannot move to any other status', async () => {
    await seedOrder('ord_os04', 'cancelled');
    const { status, data } = await patch('ord_os04', 'processing', 'staff');
    assert.equal(status, 400);
    assert.equal(data.code, 'ORDER_STATUS_FINAL');
  });

  it('OS05: double-delivered — delivered_at is set once and never overwritten', async () => {
    await seedOrder('ord_os05', 'shipped');
    // First delivery
    const r1 = await patch('ord_os05', 'delivered', 'staff');
    assert.equal(r1.status, 200);
    const firstDeliveredAt = r1.data.delivered_at;
    assert.ok(firstDeliveredAt, 'delivered_at should be set on first delivery');

    // Second attempt to deliver (should be rejected — final state)
    const r2 = await patch('ord_os05', 'delivered', 'staff');
    assert.equal(r2.status, 400);
    assert.equal(r2.data.code, 'ORDER_STATUS_FINAL');
  });

  it('OS06: customer role is rejected with 403', async () => {
    await seedOrder('ord_os06', 'pending');
    const { status, data } = await patch('ord_os06', 'processing', 'customer', 'cust-1');
    assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(data)}`);
  });

  it('OS07: no auth token returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/orders/ord_os07/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processing' }),
    });
    assert.equal(res.status, 401);
  });

  it('OS08: happy-path forward transition pending → processing → shipped', async () => {
    await seedOrder('ord_os08', 'pending');

    const r1 = await patch('ord_os08', 'processing', 'admin', 'admin-1');
    assert.equal(r1.status, 200);
    assert.equal(r1.data.status, 'processing');

    const r2 = await patch('ord_os08', 'shipped', 'admin', 'admin-1');
    assert.equal(r2.status, 200);
    assert.equal(r2.data.status, 'shipped');
  });

  it('OS08b: happy-path delivered sets delivered_at', async () => {
    await seedOrder('ord_os08b', 'shipped');
    const r = await patch('ord_os08b', 'delivered', 'staff', 'staff-2');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'delivered');
    assert.ok(r.data.delivered_at, 'delivered_at must be present');
  });

  it('OS09: err.message is NOT exposed when NODE_ENV is not test', async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevDevAuth = process.env.ALLOW_DEV_AUTH;
    try {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_DEV_AUTH = '1';
      await seedOrder('ord_os09_prod', 'pending');
      const { status, data } = await patch('ord_os09_prod', 'INVALID_STATUS', 'staff');
      assert.equal(status, 400);
      assert.equal(data.error, 'Invalid order status transition');
      assert.equal(data.code, 'ORDER_STATUS_INVALID');
      assert.ok(!data.detail, 'detail must not be present in production');
      assert.ok(!data.stack, 'stack must not leak');
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevDevAuth === undefined) delete process.env.ALLOW_DEV_AUTH;
      else process.env.ALLOW_DEV_AUTH = prevDevAuth;
    }
  });
});
