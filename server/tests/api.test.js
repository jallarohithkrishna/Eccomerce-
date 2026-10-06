/**
 * Phase 4 API Test Suite — PS-01
 * Tests: Express routes with valid token, invalid token, wrong role,
 *        intake, messages, evidence, appeal, staff approve/deny/override,
 *        warehouse receive/inspect, carrier webhook, and audit chain.
 *
 * Run: node --test tests/api.test.js
 */

import { strict as assert } from 'assert';
import { describe, it, before, after, beforeEach } from 'node:test';
import http from 'node:http';
import { Buffer } from 'buffer';
import { app } from '../index.js';
import * as returnStore from '../returns/store.js';
import { _clearEvidence } from '../agent/evidence.js';

let server;
let baseUrl;

before(async () => {
  process.env.NODE_ENV = 'test';
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
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
  _clearEvidence();
});

// Helper for making requests to test server
async function req(endpoint, { method = 'GET', headers = {}, body, rawBody } = {}) {
  const url = `${baseUrl}${endpoint}`;
  const reqHeaders = { Connection: 'close', ...headers };
  let payload = rawBody;

  if (body && !rawBody) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: payload,
  });

  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { status: res.status, ok: res.ok, data };
}

// ─── 1. Auth & Role Gate Tests ──────────────────────────────────────────────

describe('API Auth & Role Security Guards', () => {
  it('API01: Missing auth header or dev-uid on protected route returns 401', async () => {
    // When no auth header is provided and NODE_ENV test bypass is not triggered by header
    const res = await req('/agent/returns', {
      headers: { 'x-dev-uid': '' },
    });
    // In our authMiddleware: if no Authorization and no x-dev-uid, it returns 401
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });

  it('API02: Customer role is blocked from calling staff-only /agent/returns (403)', async () => {
    const res = await req('/agent/returns', {
      headers: {
        'x-dev-uid': 'cust-123',
        'x-dev-role': 'customer',
      },
    });
    assert.equal(res.status, 403, 'Customer must get 403 Forbidden on staff returns list');
  });

  it('API03: Staff role is permitted to call /agent/returns (200)', async () => {
    const res = await req('/agent/returns', {
      headers: {
        'x-dev-uid': 'staff-456',
        'x-dev-role': 'staff',
      },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.returns));
  });

  it('API04: Admin role is permitted to call /agent/returns (200)', async () => {
    const res = await req('/agent/returns', {
      headers: {
        'x-dev-uid': 'admin-001',
        'x-dev-role': 'admin',
      },
    });
    assert.equal(res.status, 200);
  });

  it('API05: Customer cannot receive warehouse items (403)', async () => {
    const res = await req('/warehouse/returns/ret_test/receive', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-1', 'x-dev-role': 'customer' },
    });
    assert.equal(res.status, 403);
  });

  it('API06: /api/chat requires authentication', async () => {
    const res = await req('/api/chat', {
      method: 'POST',
      body: { message: 'Show laptops' },
      headers: { 'x-dev-uid': '' },
    });
    assert.ok([401, 403].includes(res.status));
  });
});

// ─── 2. Returns Intake & Retrieval ──────────────────────────────────────────

describe('Return Intake & Verification API', () => {
  it('API07: POST /returns/intake creates a validated return with server-calculated refund', async () => {
    const res = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-alice', 'x-dev-role': 'customer' },
      body: {
        orderId: 'ord_123',
        productId: 'prod_99',
        reason: 'defective',
        quantity: 2,
        resolutionType: 'store_credit',
      },
    });

    assert.equal(res.status, 201);
    assert.ok(res.data.success);
    assert.ok(res.data.returnRecord.id);
    assert.ok(res.data.returnRecord.rma_number.startsWith('RMA-'));
    assert.equal(res.data.returnRecord.quantity, 2);
    // 500 * 2 * 1.05 = 1050 (store_credit bonus)
    assert.equal(res.data.returnRecord.refund_amount, 1050);
  });

  it('API08: GET /returns/:id allows owner to view, denies other customers', async () => {
    // Create return for cust-alice
    const intakeRes = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-alice', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_100', reason: 'size_mismatch' },
    });
    const returnId = intakeRes.data.returnRecord.id;

    // Cust-alice reads own return -> 200
    const ownerRes = await req(`/returns/${returnId}`, {
      headers: { 'x-dev-uid': 'cust-alice', 'x-dev-role': 'customer' },
    });
    assert.equal(ownerRes.status, 200);
    assert.equal(ownerRes.data.id, returnId);

    // Cust-bob tries reading cust-alice's return -> 403
    const strangerRes = await req(`/returns/${returnId}`, {
      headers: { 'x-dev-uid': 'cust-bob', 'x-dev-role': 'customer' },
    });
    assert.equal(strangerRes.status, 403);

    // Staff can read it -> 200
    const staffRes = await req(`/returns/${returnId}`, {
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
    });
    assert.equal(staffRes.status, 200);
  });

  it('API09: GET /returns/verify/:identifier returns public sanitized data for courier scanning', async () => {
    const intakeRes = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-charlie', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_200', reason: 'wrong_item' },
    });
    const rma = intakeRes.data.returnRecord.rma_number;

    // Unauthenticated request to public verify route
    const verifyRes = await req(`/returns/verify/${rma}`);
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.data.rma_number, rma);
    assert.ok(verifyRes.data.status);
    assert.ok(verifyRes.data.pickup_details);
    // Ensure customer personal uid is not leaked in public pass
    assert.equal(verifyRes.data.userId, undefined);
    assert.equal(verifyRes.data.user_id, undefined);
  });
});

// ─── 3. Communication Messages & Appeal ─────────────────────────────────────

describe('Case Messaging & Customer Appeals', () => {
  it('API10: Customer and staff can exchange messages on a return', async () => {
    const intake = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-1', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_1', reason: 'defective' },
    });
    const returnId = intake.data.returnRecord.id;

    // Customer sends message
    const msg1 = await req(`/returns/${returnId}/messages`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-1', 'x-dev-role': 'customer' },
      body: { message: 'Can I get a replacement instead?' },
    });
    assert.equal(msg1.status, 201);
    assert.equal(msg1.data.message.text, 'Can I get a replacement instead?');

    // Staff responds
    const msg2 = await req(`/returns/${returnId}/messages`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
      body: { message: 'Yes, we will ship a replacement once inspected.' },
    });
    assert.equal(msg2.status, 201);

    // Read message thread
    const thread = await req(`/returns/${returnId}/messages`, {
      headers: { 'x-dev-uid': 'cust-1', 'x-dev-role': 'customer' },
    });
    assert.equal(thread.status, 200);
    assert.equal(thread.data.messages.length, 2);
  });

  it('API11: Appeal is blocked on non-REJECTED case, allowed on REJECTED case', async () => {
    const intake = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-2', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_2', reason: 'defect' },
    });
    const returnId = intake.data.returnRecord.id;

    // Case is currently REQUESTED -> appeal should be rejected with 400
    const earlyAppeal = await req(`/returns/${returnId}/appeal`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-2', 'x-dev-role': 'customer' },
      body: { reason: 'I think policy covers this damage' },
    });
    assert.equal(earlyAppeal.status, 400);

    // Staff denies the return
    await req(`/agent/returns/${returnId}/deny`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
      body: { reason: 'Window expired' },
    });

    // Customer appeals the REJECTED return -> succeeds and sets HUMAN_REVIEW
    const appealRes = await req(`/returns/${returnId}/appeal`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-2', 'x-dev-role': 'customer' },
      body: { reason: 'Item was delivered damaged while I was traveling' },
    });
    assert.equal(appealRes.status, 200);
    assert.equal(appealRes.data.returnRecord.status, 'HUMAN_REVIEW');
  });

  it('API11b: appeal REJECTED → HUMAN_REVIEW is the state-machine edge and stays chain-valid', async () => {
    const intake = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-appeal', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_appeal', reason: 'defect' },
    });
    const returnId = intake.data.returnRecord.id;

    const deny = await req(`/agent/returns/${returnId}/deny`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-appeal', 'x-dev-role': 'staff' },
      body: { reason: 'Outside the return window' },
    });
    assert.equal(deny.data.status, 'REJECTED');

    const appeal = await req(`/returns/${returnId}/appeal`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-appeal', 'x-dev-role': 'customer' },
      body: { reason: 'Item was damaged in transit while I was away' },
    });
    assert.equal(appeal.status, 200);
    assert.equal(appeal.data.returnRecord.status, 'HUMAN_REVIEW');

    const audit = await req(`/returns/${returnId}/audit`, {
      headers: { 'x-dev-uid': 'cust-appeal', 'x-dev-role': 'customer' },
    });
    assert.equal(audit.data.chainValid, true, 'appeal must not break the audit hash chain');

    const appealEvent = audit.data.events.find(e => e.action === 'APPEAL_FILED');
    assert.ok(appealEvent, 'APPEAL_FILED event expected');
    assert.equal(appealEvent.data.from, 'REJECTED');
    assert.equal(appealEvent.data.to, 'HUMAN_REVIEW');
  });
});

// ─── 4. Staff Actions: Approve, Deny, Override ──────────────────────────────

describe('Staff Return Management Actions', () => {
  it('API12: Staff can approve an eligible return', async () => {
    const intake = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-3', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_3', reason: 'defect' },
    });
    const returnId = intake.data.returnRecord.id;

    const approveRes = await req(`/agent/returns/${returnId}/approve`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.data.status, 'APPROVED');
  });

  it('API13: Staff can override a HUMAN_REVIEW case to APPROVED', async () => {
    const intake = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-4', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_4', reason: 'defect' },
    });
    const returnId = intake.data.returnRecord.id;

    // Staff denies it then customer appeals it into HUMAN_REVIEW
    await req(`/agent/returns/${returnId}/deny`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
    });
    await req(`/returns/${returnId}/appeal`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-4', 'x-dev-role': 'customer' },
      body: { reason: 'Special exception requested by VIP' },
    });

    // Staff overrides to APPROVED
    const overrideRes = await req(`/agent/returns/${returnId}/override`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
      body: { targetStatus: 'APPROVED', reason: 'VIP exception approved' },
    });
    assert.equal(overrideRes.status, 200);
    assert.equal(overrideRes.data.status, 'APPROVED');
  });
});

// ─── 5. Warehouse & Carrier Workflow ────────────────────────────────────────

describe('Warehouse Lifecycle & Carrier Webhook', () => {
  it('API14: Carrier webhook advances PICKUP_SCHEDULED -> IN_TRANSIT', async () => {
    const intake = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-5', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_5', reason: 'defect' },
    });
    const returnId = intake.data.returnRecord.id;

    // Staff approves
    await req(`/agent/returns/${returnId}/approve`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
    });

    // Advance to PICKUP_SCHEDULED
    await returnStore.saveReturn({
      returnRecord: { id: returnId, status: 'PICKUP_SCHEDULED' }
    });

    // Carrier webhook sends PICKED_UP
    const webhookRes = await req('/webhooks/carrier', {
      method: 'POST',
      body: {
        returnId,
        carrierStatus: 'PICKED_UP',
        trackingNumber: 'TRK-987654',
      },
    });
    assert.equal(webhookRes.status, 200);
    assert.equal(webhookRes.data.status, 'IN_TRANSIT');
  });

  it('API15: Warehouse receives and inspects package, auto-processing refund', async () => {
    const intake = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-6', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_6', reason: 'defect', quantity: 1 },
    });
    const returnId = intake.data.returnRecord.id;

    // Set to IN_TRANSIT
    await returnStore.saveReturn({
      returnRecord: { id: returnId, status: 'IN_TRANSIT', refund_amount: 500 }
    });

    // Warehouse receives
    const receiveRes = await req(`/warehouse/returns/${returnId}/receive`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'wh-1', 'x-dev-role': 'warehouse' },
    });
    assert.equal(receiveRes.status, 200);
    assert.equal(receiveRes.data.status, 'RECEIVED');

    // Warehouse inspects (passed)
    const inspectRes = await req(`/warehouse/returns/${returnId}/inspect`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'wh-1', 'x-dev-role': 'warehouse' },
      body: {
        passed: true,
        conditionNotes: 'Item intact with original tags and serial match',
      },
    });
    assert.equal(inspectRes.status, 200);
    assert.ok(['REFUND_PROCESSING', 'COMPLETED'].includes(inspectRes.data.status));
    assert.ok(inspectRes.data.refund);
  });
});

// ─── 6. Tamper-Evident Audit Chain ──────────────────────────────────────────

describe('Audit Chain Verification API', () => {
  it('API16: GET /returns/:id/audit returns a cryptographically valid SHA-256 chain', async () => {
    const intake = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-audit', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_aud', reason: 'damaged_on_arrival' },
    });
    const returnId = intake.data.returnRecord.id;

    // Perform staff actions to append events to the chain
    await req(`/agent/returns/${returnId}/approve`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-aud', 'x-dev-role': 'staff' },
    });

    await req(`/returns/${returnId}/messages`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-audit', 'x-dev-role': 'customer' },
      body: { message: 'Pickup time confirmed' },
    });

    const auditRes = await req(`/returns/${returnId}/audit`, {
      headers: { 'x-dev-uid': 'cust-audit', 'x-dev-role': 'customer' },
    });

    assert.equal(auditRes.status, 200);
    assert.equal(auditRes.data.chainValid, true);
    assert.ok(auditRes.data.eventCount >= 3);
    assert.equal(auditRes.data.events[0].action, 'RETURN_REQUESTED');
    assert.equal(auditRes.data.events[1].action, 'STAFF_APPROVED');
    assert.equal(auditRes.data.events[2].action, 'MESSAGE_ADDED');
  });
});
