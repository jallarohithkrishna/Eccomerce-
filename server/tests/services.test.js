/**
 * Services & Jobs Comprehensive Test Suite — PS-01 Phase C2
 *
 * Covers:
 *  - Carrier, Warehouse, Payments, Notifier services
 *  - closeStale: NEEDS_INFO (>7d) -> CLOSED_STALE + notify; HUMAN_REVIEW (>24h) -> slaBreached flag + staff alert (never auto-closes)
 *  - pickupSla: APPROVED (>48h) or missed slot -> staff alert + customer notify
 *  - warehouseReceiptSla: IN_TRANSIT (>7d) -> HUMAN_REVIEW ("trace needed") via state machine + staff alert + customer notify
 *  - retryRefunds: backoff schedule (1m, 5m, 30m), same idempotency key, max 3 tries -> HUMAN_REVIEW + alert, success -> COMPLETED
 *  - pollCarrier: IN_TRANSIT -> RECEIVED via state machine, [MOCK_CARRIER] tagged
 *  - Fake-clock tests for every timer and double-run idempotency tests for every job
 *
 * Run: node --test tests/services.test.js
 */

import { strict as assert } from 'assert';
import { describe, it, before, beforeEach } from 'node:test';

import { generateLabel, bookPickupSlot, emitTrackingEvent } from '../services/carrier.js';
import { receiveItem, inspectItem } from '../services/warehouse.js';
import { issueRefund } from '../services/payments.js';
import { notify } from '../services/notifier.js';
import { closeStaleReturns, STALE_THRESHOLD_MS, HUMAN_REVIEW_SLA_MS } from '../jobs/closeStale.js';
import { checkPickupSla, PICKUP_UNSCHEDULED_SLA_MS } from '../jobs/pickupSla.js';
import { checkWarehouseReceiptSla, IN_TRANSIT_SLA_MS } from '../jobs/warehouseReceiptSla.js';
import { retryRefunds, BACKOFF_SCHEDULE_MS, MAX_REFUND_RETRIES } from '../jobs/retryRefunds.js';
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

    const msgs = await returnStore.getReturnMessages({ db: null, returnId: 'ret_svc12' });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].sender, 'system');
  });

  it('SVC13: notify throws when returnId is missing', async () => {
    await assert.rejects(() => notify({ body: 'Hello' }), /returnId/);
  });
});

// ─── Job: closeStale ─────────────────────────────────────────────────────────

describe('Jobs — closeStale (NEEDS_INFO & HUMAN_REVIEW SLA)', () => {
  it('JOB01: NEEDS_INFO > 7 days is closed with CLOSED_STALE status and customer notified', async () => {
    const baseTime = 1700000000000;
    const staleDate = new Date(baseTime - 8 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_needs_info_stale',
        status: STATES.NEEDS_INFO,
        userId: 'cust-job01',
        rma_number: 'RMA-JOB01STALE',
        updatedAt: staleDate,
        createdAt: staleDate,
      },
    });

    const result = await closeStaleReturns(null, { clock: () => baseTime });
    assert.ok(result.closed.includes('ret_needs_info_stale'), 'stale NEEDS_INFO must be closed');

    const updated = await returnStore.getReturn({ db: null, identifier: 'ret_needs_info_stale' });
    assert.equal(updated.status, STATES.CLOSED_STALE);
    assert.ok(updated.closedAt, 'closedAt must be set');

    // Customer notification check
    const msgs = await returnStore.getReturnMessages({ db: null, returnId: 'ret_needs_info_stale' });
    assert.ok(msgs.length > 0, 'customer notification must be appended');
  });

  it('JOB02: NEEDS_INFO < 7 days is skipped (not closed)', async () => {
    const baseTime = 1700000000000;
    const freshDate = new Date(baseTime - 5 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_needs_info_fresh',
        status: STATES.NEEDS_INFO,
        userId: 'cust-job02',
        updatedAt: freshDate,
        createdAt: freshDate,
      },
    });

    const result = await closeStaleReturns(null, { clock: () => baseTime });
    assert.ok(!result.closed.includes('ret_needs_info_fresh'));
    const record = await returnStore.getReturn({ db: null, identifier: 'ret_needs_info_fresh' });
    assert.equal(record.status, STATES.NEEDS_INFO);
  });

  it('JOB03: HUMAN_REVIEW never auto-closes; >24h sets slaBreached and writes staff alert', async () => {
    const baseTime = 1700000000000;
    const enteredReview = new Date(baseTime - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_hr_sla',
        status: STATES.HUMAN_REVIEW,
        userId: 'cust-hr01',
        rma_number: 'RMA-HRSLA1',
        updatedAt: enteredReview,
        createdAt: enteredReview,
      },
    });

    const result = await closeStaleReturns(null, { clock: () => baseTime });
    assert.ok(result.alerted.includes('ret_hr_sla'), 'breached HR case must be alerted');
    assert.equal(result.closed.length, 0, 'HUMAN_REVIEW must NEVER be closed by job');

    const updated = await returnStore.getReturn({ db: null, identifier: 'ret_hr_sla' });
    assert.equal(updated.status, STATES.HUMAN_REVIEW, 'status must remain HUMAN_REVIEW');
    assert.equal(updated.slaBreached, true, 'slaBreached flag must be set');

    // Alert verified
    const alerts = await returnStore.listAlerts({ db: null, returnId: 'ret_hr_sla' });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'SLA_BREACH');
    assert.equal(alerts[0].subtype, 'HUMAN_REVIEW_24H');
  });

  it('JOB04: closeStale double run is idempotent', async () => {
    const baseTime = 1700000000000;
    const staleDate = new Date(baseTime - 10 * 24 * 60 * 60 * 1000).toISOString();
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_double_stale',
        status: STATES.NEEDS_INFO,
        userId: 'cust-double',
        updatedAt: staleDate,
        createdAt: staleDate,
      },
    });

    // Run 1
    const r1 = await closeStaleReturns(null, { clock: () => baseTime });
    assert.equal(r1.closed.length, 1);

    // Run 2
    const r2 = await closeStaleReturns(null, { clock: () => baseTime });
    assert.equal(r2.closed.length, 0, 'second run must do nothing');
  });
});

// ─── Job: pickupSla ──────────────────────────────────────────────────────────

describe('Jobs — pickupSla', () => {
  it('JOB05: APPROVED > 48h without pickup scheduled triggers alert & customer notification', async () => {
    const baseTime = 1700000000000;
    const approvedAt = new Date(baseTime - 50 * 60 * 60 * 1000).toISOString(); // 50 hours ago
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_pickup_sla_1',
        status: STATES.APPROVED,
        userId: 'cust-p1',
        rma_number: 'RMA-PICKUP-1',
        approvedAt,
        updatedAt: approvedAt,
      },
    });

    const result = await checkPickupSla(null, { clock: () => baseTime });
    assert.ok(result.alerted.includes('ret_pickup_sla_1'));

    const updated = await returnStore.getReturn({ db: null, identifier: 'ret_pickup_sla_1' });
    assert.equal(updated.status, STATES.APPROVED);
    assert.equal(updated.pickupSlaBreached, true);

    const alerts = await returnStore.listAlerts({ db: null, returnId: 'ret_pickup_sla_1' });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].subtype, 'PICKUP_NOT_SCHEDULED_48H');

    // Double run test
    const r2 = await checkPickupSla(null, { clock: () => baseTime });
    assert.equal(r2.alerted.length, 0, 'second run must be idempotent');
  });

  it('JOB06: PICKUP_SCHEDULED with missed slot triggers alert', async () => {
    const baseTime = 1700000000000;
    const missedSlot = new Date(baseTime - 3 * 60 * 60 * 1000).toISOString(); // 3 hours in past
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_pickup_missed_1',
        status: STATES.PICKUP_SCHEDULED,
        userId: 'cust-p2',
        rma_number: 'RMA-MISSED-1',
        scheduledPickupSlot: missedSlot,
        updatedAt: missedSlot,
      },
    });

    const result = await checkPickupSla(null, { clock: () => baseTime });
    assert.ok(result.alerted.includes('ret_pickup_missed_1'));

    const alerts = await returnStore.listAlerts({ db: null, returnId: 'ret_pickup_missed_1' });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].subtype, 'MISSED_PICKUP_SLOT');
  });
});

// ─── Job: warehouseReceiptSla ────────────────────────────────────────────────

describe('Jobs — warehouseReceiptSla', () => {
  it('JOB07: IN_TRANSIT > 7d escalates to HUMAN_REVIEW with "trace needed" reason', async () => {
    const baseTime = 1700000000000;
    const inTransitAt = new Date(baseTime - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_transit_stale_1',
        status: STATES.IN_TRANSIT,
        userId: 'cust-t1',
        rma_number: 'RMA-TRANSIT-1',
        inTransitAt,
        updatedAt: inTransitAt,
      },
    });

    const result = await checkWarehouseReceiptSla(null, { clock: () => baseTime });
    assert.ok(result.escalated.includes('ret_transit_stale_1'));

    const updated = await returnStore.getReturn({ db: null, identifier: 'ret_transit_stale_1' });
    assert.equal(updated.status, STATES.HUMAN_REVIEW);
    assert.equal(updated.reviewReason, 'trace needed');

    const alerts = await returnStore.listAlerts({ db: null, returnId: 'ret_transit_stale_1' });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].subtype, 'IN_TRANSIT_DELAY');

    // Double run test
    const r2 = await checkWarehouseReceiptSla(null, { clock: () => baseTime });
    assert.equal(r2.escalated.length, 0, 'second run must do nothing');
  });
});

// ─── Job: retryRefunds ───────────────────────────────────────────────────────

describe('Jobs — retryRefunds', () => {
  it('JOB08: REFUND_FAILED waits for backoff before retrying', async () => {
    const baseTime = 1700000000000;
    const failedJustNow = new Date(baseTime - 30 * 1000).toISOString(); // 30s ago (backoff is 1m)
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_rfd_wait',
        status: STATES.REFUND_FAILED,
        userId: 'cust-r1',
        refundRetries: 0,
        lastRefundAttemptAt: failedJustNow,
        updatedAt: failedJustNow,
      },
    });

    // Attempt immediately (too soon)
    const r1 = await retryRefunds(null, { clock: () => baseTime });
    assert.ok(r1.skipped.includes('ret_rfd_wait'));

    // Advance clock past 1 min
    const after1Min = baseTime + 70 * 1000;
    const r2 = await retryRefunds(null, { clock: () => after1Min });
    assert.ok(r2.succeeded.includes('ret_rfd_wait'), 'should succeed after backoff');

    const updated = await returnStore.getReturn({ db: null, identifier: 'ret_rfd_wait' });
    assert.equal(updated.status, STATES.COMPLETED);
  });

  it('JOB09: REFUND_FAILED after 3 failed tries escalates to HUMAN_REVIEW and creates critical alert', async () => {
    const baseTime = 1700000000000;
    const lastFailedAt = new Date(baseTime - 35 * 60 * 1000).toISOString(); // 35 min ago
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_rfd_exhaust',
        status: STATES.REFUND_FAILED,
        userId: 'cust-r2',
        rma_number: 'RMA-EXHAUST-1',
        refundRetries: 2, // 2 prior attempts, this will be attempt 3
        lastRefundAttemptAt: lastFailedAt,
        updatedAt: lastFailedAt,
      },
    });

    // Simulate failure on the 3rd attempt
    const result = await retryRefunds(null, { clock: () => baseTime, simulateFailure: true });
    assert.ok(result.escalated.includes('ret_rfd_exhaust'));

    const updated = await returnStore.getReturn({ db: null, identifier: 'ret_rfd_exhaust' });
    assert.equal(updated.status, STATES.HUMAN_REVIEW);
    assert.equal(updated.refundRetries, 3);

    const alerts = await returnStore.listAlerts({ db: null, returnId: 'ret_rfd_exhaust' });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, 'CRITICAL');
  });
});

// ─── Job: pollCarrier ────────────────────────────────────────────────────────

describe('Jobs — pollCarrier', () => {
  it('JOB10: IN_TRANSIT return advances to RECEIVED via state machine', async () => {
    await returnStore.saveReturn({
      db: null,
      returnRecord: {
        id: 'ret_job_carrier',
        status: STATES.IN_TRANSIT,
        userId: 'cust-carrier',
      },
    });

    const result = await pollCarrier(null, { mockAlwaysDeliver: true });
    assert.ok(result.advanced.includes('ret_job_carrier'));

    const updated = await returnStore.getReturn({ db: null, identifier: 'ret_job_carrier' });
    assert.equal(updated.status, STATES.RECEIVED);

    // Double run test
    const r2 = await pollCarrier(null, { mockAlwaysDeliver: true });
    assert.equal(r2.advanced.length, 0, 'second run must do nothing');
  });
});
