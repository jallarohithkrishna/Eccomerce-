/**
 * Services & Jobs Tests — PS-01 Phase C2
 *
 * SVC01 – carrier.generateLabel returns a valid label object
 * SVC02 – carrier.bookPickupSlot returns a scheduled slot
 * SVC03 – carrier.emitTrackingEvent returns a tracking event
 * SVC04 – warehouse.receiveItem returns a receipt
 * SVC05 – warehouse.inspectItem pass outcome
 * SVC06 – warehouse.inspectItem fail outcome (refundEligible = false)
 * SVC07 – warehouse.inspectItem rejects invalid outcome
 * SVC08 – payments.issueRefund succeeds
 * SVC09 – payments.issueRefund fails with simulateFailure flag
 * SVC10 – payments.issueRefund rejects missing returnId
 * SVC11 – payments.issueRefund rejects zero/negative amount
 * SVC12 – notifier.notify saves in-app message and returns messageId
 * SVC13 – notifier.notify without returnId throws
 * JOB01 – closeStale: marks stale HUMAN_REVIEW returns as CLOSED_STALE
 * JOB02 – closeStale: skips returns that are not yet stale
 * JOB03 – pollCarrier: advances IN_TRANSIT to RECEIVED when MOCK_CARRIER_ALWAYS_DELIVER=1
 *
 * Run: node --test tests/services.test.js
 */

import { strict as assert } from 'assert';
import { describe, it, before, beforeEach } from 'node:test';

import { generateLabel, bookPickupSlot, emitTrackingEvent } from '../services/carrier.js';
import { receiveItem, inspectItem } from '../services/warehouse.js';
import { issueRefund } from '../services/payments.js';
import { notify } from '../services/notifier.js';
import { closeStaleReturns, STALE_THRESHOLD_MS } from '../jobs/closeStale.js';
import { pollCarrier } from '../jobs/pollCarrier.js';
import * as returnStore from '../returns/store.js';
import { STATES } from '../returns/stateMachine.js';

before(() => {
  process.env.NODE_ENV = 'test';
});

beforeEach(() => {
  returnStore._clearAll();
  delete process.env.SIMULATE_PAYMENT_FAILURE;
  delete process.env.MOCK_CARRIER_ALWAYS_DELIVER;
});

// ─── Carrier Service ──────────────────────────────────────────────────────────

describe('Services — Carrier', () => {
  it('SVC01: generateLabel returns a label object with labelId and labelUrl', async () => {
    const label = await generateLabel({ returnId: 'ret_svc01', address: '1 Main St' });
    assert.ok(label.labelId, 'labelId must be present');
    assert.ok(label.labelUrl, 'labelUrl must be present');
    assert.equal(label.returnId, 'ret_svc01');
    assert.match(label.labelId, /^LBL-/);
  });

  it('SVC01b: generateLabel throws when returnId is missing', async () => {
    await assert.rejects(() => generateLabel({ address: '1 Main St' }), /returnId/);
  });

  it('SVC02: bookPickupSlot returns a scheduled slot', async () => {
    const slot = await bookPickupSlot({ returnId: 'ret_svc02', address: '2 Main St' });
    assert.ok(slot.slotId, 'slotId must be present');
    assert.equal(slot.status, 'SCHEDULED');
    assert.ok(slot.scheduledAt, 'scheduledAt must be present');
  });

  it('SVC03: emitTrackingEvent returns a tracking event', async () => {
    const ev = await emitTrackingEvent({ returnId: 'ret_svc03', event: 'PICKED_UP' });
    assert.ok(ev.eventId, 'eventId must be present');
    assert.equal(ev.event, 'PICKED_UP');
    assert.equal(ev.returnId, 'ret_svc03');
  });

  it('SVC03b: emitTrackingEvent throws when event is missing', async () => {
    await assert.rejects(() => emitTrackingEvent({ returnId: 'ret_svc03b' }), /event/);
  });
});

// ─── Warehouse Service ────────────────────────────────────────────────────────

describe('Services — Warehouse', () => {
  it('SVC04: receiveItem returns a receipt', async () => {
    const r = await receiveItem({ returnId: 'ret_svc04', condition: 'good', notes: 'Box intact' });
    assert.ok(r.receiptId, 'receiptId must be present');
    assert.equal(r.status, 'RECEIVED');
    assert.equal(r.returnId, 'ret_svc04');
  });

  it('SVC05: inspectItem pass returns refundEligible=true', async () => {
    const r = await inspectItem({ returnId: 'ret_svc05', outcome: 'pass' });
    assert.equal(r.outcome, 'pass');
    assert.equal(r.refundEligible, true);
  });

  it('SVC06: inspectItem fail returns refundEligible=false', async () => {
    const r = await inspectItem({ returnId: 'ret_svc06', outcome: 'fail' });
    assert.equal(r.outcome, 'fail');
    assert.equal(r.refundEligible, false);
  });

  it('SVC07: inspectItem rejects an invalid outcome', async () => {
    await assert.rejects(
      () => inspectItem({ returnId: 'ret_svc07', outcome: 'unknown_outcome' }),
      /outcome must be one of/
    );
  });
});

// ─── Payments Service ─────────────────────────────────────────────────────────

describe('Services — Payments', () => {
  it('SVC08: issueRefund succeeds and returns status=success', async () => {
    const r = await issueRefund({ returnId: 'ret_svc08', amount: 1000 });
    assert.equal(r.status, 'success');
    assert.ok(r.refundId, 'refundId must be present');
    assert.equal(r.amount, 1000);
  });

  it('SVC09: issueRefund fails when simulateFailure=true', async () => {
    const r = await issueRefund({ returnId: 'ret_svc09', amount: 500, simulateFailure: true });
    assert.equal(r.status, 'failed');
    assert.ok(r.failureReason, 'failureReason must be present');
  });

  it('SVC09b: issueRefund fails when SIMULATE_PAYMENT_FAILURE=1', async () => {
    process.env.SIMULATE_PAYMENT_FAILURE = '1';
    const r = await issueRefund({ returnId: 'ret_svc09b', amount: 250 });
    assert.equal(r.status, 'failed');
    delete process.env.SIMULATE_PAYMENT_FAILURE;
  });

  it('SVC10: issueRefund throws when returnId is missing', async () => {
    await assert.rejects(() => issueRefund({ amount: 100 }), /returnId/);
  });

  it('SVC11: issueRefund throws on zero or negative amount', async () => {
    await assert.rejects(() => issueRefund({ returnId: 'ret_svc11', amount: 0 }), /positive/);
    await assert.rejects(() => issueRefund({ returnId: 'ret_svc11b', amount: -50 }), /positive/);
  });
});

// ─── Notifier Service ─────────────────────────────────────────────────────────

describe('Services — Notifier', () => {
  it('SVC12: notify saves an in-app message and returns messageId', async () => {
    await returnStore.saveReturn({ db: null, returnRecord: { id: 'ret_svc12', status: 'APPROVED' } });
    const r = await notify({
      db: null,
      returnId: 'ret_svc12',
      toUserId: 'cust-1',
      toEmail: 'cust@example.com',
      subject: 'Your return is approved',
      body: 'Your return has been approved. Pickup tomorrow.',
    });
    assert.ok(r.messageId, 'messageId must be present');
    assert.equal(r.returnId, 'ret_svc12');
    assert.equal(r.emailSent, true);

    // Verify the message is in the store
    const msgs = await returnStore.getReturnMessages({ db: null, returnId: 'ret_svc12' });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].sender, 'system');
  });

  it('SVC13: notify throws when returnId is missing', async () => {
    await assert.rejects(() => notify({ body: 'Hello' }), /returnId/);
  });
});

// ─── Jobs ─────────────────────────────────────────────────────────────────────

describe('Jobs — closeStale', () => {
  it('JOB01: stale HUMAN_REVIEW return is closed with CLOSED_STALE status', async () => {
    // Seed a stale return (updatedAt 8 days ago)
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_job01',
        status: STATES.HUMAN_REVIEW,
        userId: 'cust-job01',
        rma_number: 'RMA-JOB01STALE',
        updatedAt: staleDate,
        createdAt: staleDate,
      },
    });

    const result = await closeStaleReturns(null);
    assert.ok(result.closed.includes('ret_job01'), `expected ret_job01 in closed: ${JSON.stringify(result)}`);
    assert.equal(result.errors.length, 0, `unexpected errors: ${result.errors}`);

    // Verify the in-memory record was updated
    const updated = await returnStore.getReturn({ db: null, identifier: 'ret_job01' });
    assert.equal(updated.status, 'CLOSED_STALE');
    assert.ok(updated.closedAt, 'closedAt must be set');
  });

  it('JOB02: return updated recently is not closed (skipped)', async () => {
    // Seed a fresh return (updatedAt 1 hour ago)
    const freshDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_job02',
        status: STATES.HUMAN_REVIEW,
        userId: 'cust-job02',
        updatedAt: freshDate,
        createdAt: freshDate,
      },
    });

    const result = await closeStaleReturns(null);
    assert.ok(!result.closed.includes('ret_job02'), 'fresh return must NOT be closed');
  });
});

describe('Jobs — pollCarrier', () => {
  it('JOB03: IN_TRANSIT return advances to RECEIVED when MOCK_CARRIER_ALWAYS_DELIVER=1', async () => {
    process.env.MOCK_CARRIER_ALWAYS_DELIVER = '1';
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_job03',
        status: STATES.IN_TRANSIT,
        userId: 'cust-job03',
      },
    });

    const result = await pollCarrier(null);
    assert.ok(result.advanced.includes('ret_job03'), `expected ret_job03 in advanced: ${JSON.stringify(result)}`);

    const updated = await returnStore.getReturn({ db: null, identifier: 'ret_job03' });
    assert.equal(updated.status, STATES.RECEIVED);
    delete process.env.MOCK_CARRIER_ALWAYS_DELIVER;
  });
});
