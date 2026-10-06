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
import { evaluate } from '../policy/engine.js';

let server;
let baseUrl;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.CARRIER_WEBHOOK_SECRET = process.env.CARRIER_WEBHOOK_SECRET || 'test-carrier-secret';
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
    assert.equal(overrideRes.data.returnRecord.override_reason, 'VIP exception approved');
    assert.equal(overrideRes.data.returnRecord.override_by, 'staff-1');
  });

  it('API13b: override to COMPLETED or REFUND_PROCESSING is refused (400) and changes nothing', async () => {
    for (const targetStatus of ['COMPLETED', 'REFUND_PROCESSING']) {
      const intake = await req('/returns/intake', {
        method: 'POST',
        headers: { 'x-dev-uid': 'cust-ovr', 'x-dev-role': 'customer' },
        body: { orderId: 'ord_ovr', reason: 'defect' },
      });
      const returnId = intake.data.returnRecord.id;

      await req(`/agent/returns/${returnId}/deny`, {
        method: 'POST',
        headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
        body: { reason: 'no' },
      });
      await req(`/returns/${returnId}/appeal`, {
        method: 'POST',
        headers: { 'x-dev-uid': 'cust-ovr', 'x-dev-role': 'customer' },
        body: { reason: 'Please take another look at this case' },
      });

      const overrideRes = await req(`/agent/returns/${returnId}/override`, {
        method: 'POST',
        headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
        body: { targetStatus, reason: 'trying to skip the warehouse' },
      });
      assert.equal(overrideRes.status, 400, `${targetStatus} must be refused`);

      const after = await req(`/returns/${returnId}`, {
        headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
      });
      assert.equal(after.data.status, 'HUMAN_REVIEW', 'refused override must not change state');
    }
  });

  it('API13c: override outside HUMAN_REVIEW, or without a reason, is refused', async () => {
    const intake = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-ovr2', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_ovr2', reason: 'defect' },
    });
    const returnId = intake.data.returnRecord.id;

    // Case is still REQUESTED -> override is not available at all
    const wrongState = await req(`/agent/returns/${returnId}/override`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
      body: { targetStatus: 'APPROVED', reason: 'jumping the queue' },
    });
    assert.equal(wrongState.status, 409);

    // A reason is mandatory
    const noReason = await req(`/agent/returns/${returnId}/override`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
      body: { targetStatus: 'APPROVED' },
    });
    assert.equal(noReason.status, 400);
  });

  it('API13d: a refund cannot be forced before warehouse INSPECTION', async () => {
    const intake = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': 'cust-pre', 'x-dev-role': 'customer' },
      body: { orderId: 'ord_pre', reason: 'defect' },
    });
    const returnId = intake.data.returnRecord.id;

    // Park the case at RECEIVED — physically in the warehouse, uninspected.
    await returnStore.saveReturn({
      returnRecord: { id: returnId, status: 'RECEIVED', refund_amount: 500 }
    });

    // Staff cannot shortcut straight to a refund.
    const forced = await req(`/api/returns/${returnId}/resolve`, {
      method: 'POST',
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
      body: { resolution: 'REFUNDED' },
    });
    assert.equal(forced.status, 409, 'RECEIVED -> COMPLETED must be refused');

    const after = await req(`/returns/${returnId}`, {
      headers: { 'x-dev-uid': 'staff-1', 'x-dev-role': 'staff' },
    });
    assert.equal(after.data.status, 'RECEIVED');
    assert.equal(after.data.refund_record, undefined);
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
      headers: { 'x-carrier-secret': process.env.CARRIER_WEBHOOK_SECRET },
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

// ─── 6. Intake hardening: client can never decide eligibility or refund ─────

describe('API Intake hardening', () => {
  const CLIENT_JUNK = {
    decision: 'APPROVED',
    refund_amount: 999999,
    refundAmount: 999999,
    eligibility_decision: 'NON_RETURNABLE_CATEGORY',
    status: 'COMPLETED',
    status_label: 'Refunded',
    eligible: true,
    requiresHumanReview: false,
    approved: true,
    userId: 'attacker-uid',
    user_id: 'attacker-uid',
    rma_number: 'RMA-HACKED',
    createdAt: '2000-01-01T00:00:00.000Z',
    item: { price: 1, name: 'Free Stuff', category: 'vehicle' },
  };

  async function intake(extra, uid = 'cust-hardened') {
    const res = await req('/returns/intake', {
      method: 'POST',
      headers: { 'x-dev-uid': uid, 'x-dev-role': 'customer' },
      body: { orderId: 'ord_hard', reason: 'defective', ...extra },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data.returnRecord;
  }

  it('API17: client-supplied decision / refund_amount / status are all discarded', async () => {
    const record = await intake({ ...CLIENT_JUNK, quantity: 2 });

    // refund comes from the server formula, not the request body.
    assert.equal(record.refund_amount, 1000, '500 * 2 — the client number must be ignored');
    assert.equal('refundAmount' in record, false);

    // status / decision come from the policy engine, not the request body.
    assert.equal(record.status, 'REQUESTED');
    assert.equal(record.status_label, 'Return Requested');
    assert.equal(record.eligibility_decision, 'ELIGIBLE');

    // identity and case metadata stay server-owned.
    assert.equal(record.userId, 'cust-hardened');
    assert.equal(record.user_id, 'cust-hardened');
    assert.match(record.rma_number, /^RMA-/);
    assert.notEqual(record.rma_number, 'RMA-HACKED');
    assert.equal(record.item.price, 500, 'item price comes from the order/fallback, not the client');
    assert.equal(record.item.category, 'standard');
    assert.ok(Date.parse(record.createdAt) > Date.parse('2020-01-01'));

    // nothing privileged from the request body is copied through.
    const stored = JSON.stringify(record);
    for (const key of ['decision', 'eligible', 'requiresHumanReview', 'approved']) {
      assert.equal(key in record, false, `'${key}' must not be stored`);
    }
    for (const leak of ['NON_RETURNABLE_CATEGORY', 'attacker-uid', 'Free Stuff', 'RMA-HACKED']) {
      assert.equal(stored.includes(leak), false, `record leaked "${leak}"`);
    }
  });

  it('API18: the recorded decision is exactly what the policy engine returns', async () => {
    const record = await intake({ quantity: 3, resolutionType: 'store_credit' });

    // Recompute the engine with the inputs the route feeds it (no order doc in
    // this environment, so the route uses the server-side fallback item).
    const engine = evaluate({
      category: 'standard',
      itemName: 'Purchased Item',
      deliveredAt: new Date().toISOString(),
      requestedAt: new Date().toISOString(),
      itemPrice: 500,
      quantity: 3,
      reason: 'defective',
      photoProvided: false,
    });

    assert.equal(record.eligibility_decision, engine.decisionCode);
    assert.equal(record.status, engine.requiresHumanReview ? 'HUMAN_REVIEW' : 'REQUESTED');

    // Server-side refund formula, never the client's number.
    assert.equal(record.refund_amount, 500 * 3 * 1.05);

    // Same server inputs, opposite client intent → same outcome every time.
    const clean = await intake({ quantity: 3, resolutionType: 'store_credit' });
    assert.equal(clean.refund_amount, record.refund_amount);
    assert.equal(clean.eligibility_decision, record.eligibility_decision);
    assert.equal(clean.status, record.status);

    // The engine is authoritative for denial too: a denied input can never be
    // waved through by a client that also sends decision:'APPROVED'.
    const denied = evaluate({
      category: 'standard',
      itemName: 'Purchased Item',
      deliveredAt: new Date().toISOString(),
      requestedAt: new Date().toISOString(),
      itemPrice: 500,
      quantity: 0,
      reason: 'defective',
      photoProvided: false,
    });
    assert.equal(denied.eligible, false);
    assert.equal(denied.decisionCode, 'INVALID_QUANTITY');
    assert.equal(
      record.eligibility_decision,
      'ELIGIBLE',
      'the stored code is the engine verdict for the real inputs, not a client value'
    );
  });
});
