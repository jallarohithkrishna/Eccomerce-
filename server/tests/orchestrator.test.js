/**
 * Phase 3 Tests — State Machine, Audit Chain, Refund Idempotency
 * Run: node --test tests/orchestrator.test.js
 */

import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import {
  STATES,
  assertTransition,
  canTransition,
  allowedTransitions,
  isTerminal,
  ReturnStateError,
} from '../returns/stateMachine.js';

import {
  createEvent,
  verifyChain,
  GENESIS_HASH,
} from '../returns/audit.js';

import {
  initiateRefund,
  retryRefund,
  cancelRefund,
  getRefund,
  _ledger,
} from '../returns/refunds.js';

import { evaluateException, ExceptionAction } from '../returns/exceptions.js';

// ─── State Machine ─────────────────────────────────────────────────────────

describe('State Machine — legal transitions', () => {
  it('SM01 REQUESTED → VERIFYING is legal', () => {
    assert.doesNotThrow(() => assertTransition(STATES.REQUESTED, STATES.VERIFYING));
  });
  it('SM02 VERIFYING → ELIGIBILITY_CHECK is legal', () => {
    assert.doesNotThrow(() => assertTransition(STATES.VERIFYING, STATES.ELIGIBILITY_CHECK));
  });
  it('SM03 ELIGIBILITY_CHECK → APPROVED is legal', () => {
    assert.doesNotThrow(() => assertTransition(STATES.ELIGIBILITY_CHECK, STATES.APPROVED));
  });
  it('SM04 APPROVED → PICKUP_SCHEDULED is legal', () => {
    assert.doesNotThrow(() => assertTransition(STATES.APPROVED, STATES.PICKUP_SCHEDULED));
  });
  it('SM05 PICKUP_SCHEDULED → IN_TRANSIT is legal', () => {
    assert.doesNotThrow(() => assertTransition(STATES.PICKUP_SCHEDULED, STATES.IN_TRANSIT));
  });
  it('SM06 IN_TRANSIT → RECEIVED is legal', () => {
    assert.doesNotThrow(() => assertTransition(STATES.IN_TRANSIT, STATES.RECEIVED));
  });
  it('SM07 RECEIVED → INSPECTION is legal', () => {
    assert.doesNotThrow(() => assertTransition(STATES.RECEIVED, STATES.INSPECTION));
  });
  it('SM08 INSPECTION → REFUND_PROCESSING is legal', () => {
    assert.doesNotThrow(() => assertTransition(STATES.INSPECTION, STATES.REFUND_PROCESSING));
  });
  it('SM09 REFUND_PROCESSING → COMPLETED is legal', () => {
    assert.doesNotThrow(() => assertTransition(STATES.REFUND_PROCESSING, STATES.COMPLETED));
  });
  it('SM10 any state → HUMAN_REVIEW is legal', () => {
    const normalStates = [
      STATES.REQUESTED, STATES.VERIFYING, STATES.ELIGIBILITY_CHECK,
      STATES.APPROVED, STATES.PICKUP_SCHEDULED, STATES.IN_TRANSIT,
      STATES.RECEIVED, STATES.INSPECTION, STATES.REFUND_PROCESSING,
    ];
    for (const s of normalStates) {
      assert.equal(canTransition(s, STATES.HUMAN_REVIEW), true, `${s} → HUMAN_REVIEW should be legal`);
    }
  });
  it('SM11 HUMAN_REVIEW → APPROVED is legal (manual override)', () => {
    assert.doesNotThrow(() => assertTransition(STATES.HUMAN_REVIEW, STATES.APPROVED));
  });
});

describe('State Machine — illegal transitions', () => {
  it('SM12 REQUESTED → COMPLETED is illegal', () => {
    assert.throws(() => assertTransition(STATES.REQUESTED, STATES.COMPLETED), ReturnStateError);
  });
  it('SM13 COMPLETED → any is illegal (terminal)', () => {
    assert.throws(() => assertTransition(STATES.COMPLETED, STATES.REQUESTED), ReturnStateError);
    assert.throws(() => assertTransition(STATES.COMPLETED, STATES.REFUND_PROCESSING), ReturnStateError);
  });
  it('SM14 REJECTED → HUMAN_REVIEW is legal via appeal only; every other REJECTED move is illegal', () => {
    // The appeal exception is the single legal edge out of REJECTED.
    assert.doesNotThrow(() => assertTransition(STATES.REJECTED, STATES.HUMAN_REVIEW));
    assert.equal(canTransition(STATES.REJECTED, STATES.HUMAN_REVIEW), true);
    // REJECTED stays terminal for every other transition.
    assert.throws(() => assertTransition(STATES.REJECTED, STATES.APPROVED), ReturnStateError);
    assert.throws(() => assertTransition(STATES.REJECTED, STATES.COMPLETED), ReturnStateError);
    assert.throws(() => assertTransition(STATES.REJECTED, STATES.REFUND_PROCESSING), ReturnStateError);
    assert.throws(() => assertTransition(STATES.REJECTED, STATES.REQUESTED), ReturnStateError);
    assert.throws(() => assertTransition(STATES.REJECTED, STATES.RECEIVED), ReturnStateError);
    assert.equal(isTerminal(STATES.REJECTED), true, 'appeal edge must not make REJECTED non-terminal');
  });
  it('SM15 REFUND_PROCESSING → REQUESTED is illegal (backward skip)', () => {
    assert.throws(() => assertTransition(STATES.REFUND_PROCESSING, STATES.REQUESTED), ReturnStateError);
  });
  it('SM16 RECEIVED → REFUND_PROCESSING is illegal (skips INSPECTION)', () => {
    assert.throws(() => assertTransition(STATES.RECEIVED, STATES.REFUND_PROCESSING), ReturnStateError);
  });
});

describe('State Machine — Phase C2 States & Legal Transitions', () => {
  it('SM21 NEEDS_INFO transitions', () => {
    assert.doesNotThrow(() => assertTransition(STATES.REQUESTED, STATES.NEEDS_INFO));
    assert.doesNotThrow(() => assertTransition(STATES.VERIFYING, STATES.NEEDS_INFO));
    assert.doesNotThrow(() => assertTransition(STATES.ELIGIBILITY_CHECK, STATES.NEEDS_INFO));
    assert.doesNotThrow(() => assertTransition(STATES.HUMAN_REVIEW, STATES.NEEDS_INFO));
    assert.doesNotThrow(() => assertTransition(STATES.NEEDS_INFO, STATES.VERIFYING));
    assert.doesNotThrow(() => assertTransition(STATES.NEEDS_INFO, STATES.ELIGIBILITY_CHECK));
    assert.doesNotThrow(() => assertTransition(STATES.NEEDS_INFO, STATES.HUMAN_REVIEW));
    assert.doesNotThrow(() => assertTransition(STATES.NEEDS_INFO, STATES.CLOSED_STALE));
    assert.throws(() => assertTransition(STATES.NEEDS_INFO, STATES.COMPLETED), ReturnStateError);
  });

  it('SM22 CLOSED_STALE is terminal and cannot transition to anything', () => {
    assert.equal(isTerminal(STATES.CLOSED_STALE), true);
    assert.throws(() => assertTransition(STATES.CLOSED_STALE, STATES.REQUESTED), ReturnStateError);
    assert.throws(() => assertTransition(STATES.CLOSED_STALE, STATES.HUMAN_REVIEW), ReturnStateError);
    assert.throws(() => assertTransition(STATES.CLOSED_STALE, STATES.COMPLETED), ReturnStateError);
  });

  it('SM23 REFUND_FAILED transitions', () => {
    assert.doesNotThrow(() => assertTransition(STATES.REFUND_PROCESSING, STATES.REFUND_FAILED));
    assert.doesNotThrow(() => assertTransition(STATES.REFUND_FAILED, STATES.REFUND_PROCESSING));
    assert.doesNotThrow(() => assertTransition(STATES.REFUND_FAILED, STATES.HUMAN_REVIEW));
    assert.doesNotThrow(() => assertTransition(STATES.REFUND_FAILED, STATES.REJECTED));
    assert.throws(() => assertTransition(STATES.REFUND_FAILED, STATES.APPROVED), ReturnStateError);
    assert.throws(() => assertTransition(STATES.REFUND_FAILED, STATES.IN_TRANSIT), ReturnStateError);
  });

  it('SM24 REPLACEMENT_SHIPPED transitions', () => {
    assert.doesNotThrow(() => assertTransition(STATES.APPROVED, STATES.REPLACEMENT_SHIPPED));
    assert.doesNotThrow(() => assertTransition(STATES.INSPECTION, STATES.REPLACEMENT_SHIPPED));
    assert.doesNotThrow(() => assertTransition(STATES.HUMAN_REVIEW, STATES.REPLACEMENT_SHIPPED));
    assert.doesNotThrow(() => assertTransition(STATES.REPLACEMENT_SHIPPED, STATES.COMPLETED));
    assert.throws(() => assertTransition(STATES.REPLACEMENT_SHIPPED, STATES.REQUESTED), ReturnStateError);
    assert.throws(() => assertTransition(STATES.REPLACEMENT_SHIPPED, STATES.REFUND_PROCESSING), ReturnStateError);
  });

  it('SM25 Terminal states never move, except the REJECTED → HUMAN_REVIEW appeal edge', () => {
    // COMPLETED terminal
    assert.equal(isTerminal(STATES.COMPLETED), true);
    for (const target of Object.values(STATES)) {
      assert.throws(() => assertTransition(STATES.COMPLETED, target), ReturnStateError);
    }

    // CLOSED_STALE terminal
    assert.equal(isTerminal(STATES.CLOSED_STALE), true);
    for (const target of Object.values(STATES)) {
      assert.throws(() => assertTransition(STATES.CLOSED_STALE, target), ReturnStateError);
    }

    // REJECTED terminal except appeal
    assert.equal(isTerminal(STATES.REJECTED), true);
    assert.doesNotThrow(() => assertTransition(STATES.REJECTED, STATES.HUMAN_REVIEW));
    for (const target of Object.values(STATES)) {
      if (target !== STATES.HUMAN_REVIEW) {
        assert.throws(() => assertTransition(STATES.REJECTED, target), ReturnStateError);
      }
    }
  });
});


// ─── Audit Chain ──────────────────────────────────────────────────────────

describe('Audit Chain', () => {
  it('AU01 create and verify a 3-event chain', () => {
    const e1 = createEvent({ returnId: 'R1', previousHash: GENESIS_HASH, actor: 'system', action: 'INTAKE', data: {} });
    const e2 = createEvent({ returnId: 'R1', previousHash: e1.hash, actor: 'system', action: 'POLICY_CHECK', data: {} });
    const e3 = createEvent({ returnId: 'R1', previousHash: e2.hash, actor: 'agent', action: 'APPROVE', data: {} });
    const result = verifyChain([e1, e2, e3]);
    assert.equal(result.valid, true);
  });

  it('AU02 empty chain is valid', () => {
    assert.equal(verifyChain([]).valid, true);
  });

  it('AU03 tampered data field fails verification', () => {
    const e1 = createEvent({ returnId: 'R2', previousHash: GENESIS_HASH, actor: 'system', action: 'INTAKE', data: {} });
    const tampered = { ...e1, data: { injected: true } }; // mutate data but keep old hash
    const result = verifyChain([tampered]);
    assert.equal(result.valid, false);
    assert.equal(result.firstBadIndex, 0);
  });

  it('AU04 broken chain linkage detected', () => {
    const e1 = createEvent({ returnId: 'R3', previousHash: GENESIS_HASH, actor: 'system', action: 'A', data: {} });
    const e2 = createEvent({ returnId: 'R3', previousHash: GENESIS_HASH, actor: 'system', action: 'B', data: {} }); // wrong prev
    const result = verifyChain([e1, e2]);
    assert.equal(result.valid, false);
    assert.equal(result.firstBadIndex, 1);
  });

  it('AU05 event hash changes if returnId changes', () => {
    const isoTimestamp = '2026-01-01T00:00:00.000Z';
    const e1 = createEvent({ returnId: 'R4', previousHash: GENESIS_HASH, actor: 'system', action: 'X', data: {}, isoTimestamp });
    const e2 = createEvent({ returnId: 'R4', previousHash: GENESIS_HASH, actor: 'system', action: 'X', data: {}, isoTimestamp });
    const e3 = createEvent({ returnId: 'R5', previousHash: GENESIS_HASH, actor: 'system', action: 'X', data: {}, isoTimestamp });
    // Same content → same hash (deterministic)
    assert.equal(e1.hash, e2.hash);
    // Different returnId → different hash
    assert.notEqual(e1.hash, e3.hash);
  });
});

// ─── Refund Idempotency ───────────────────────────────────────────────────

describe('Refund idempotency', () => {
  // Use unique IDs per test to avoid ledger cross-contamination
  it('RF01 successful refund stores record', async () => {
    const r = await initiateRefund({ returnId: 'RF-TEST-01', amount: 999, method: 'original_payment', initiatedBy: 'agent' });
    assert.ok(['COMPLETED', 'FAILED'].includes(r.status)); // mock may randomly fail
    assert.equal(r.returnId, 'RF-TEST-01');
    assert.equal(r.amount, 999);
  });

  it('RF02 calling initiateRefund again with same amount while COMPLETED → returns same record (idempotent)', async () => {
    // Force a success by seeding ledger manually
    const id = 'RF-TEST-02';
    _ledger().set(id, {
      returnId: id, amount: 500, status: 'COMPLETED', method: 'store_credit',
      transactionId: 'TXN-MANUAL', initiatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(), cancelledAt: null, failureReason: null,
    });
    const r = await initiateRefund({ returnId: id, amount: 500, method: 'store_credit', initiatedBy: 'agent' });
    assert.equal(r.status, 'COMPLETED');
    assert.equal(r.transactionId, 'TXN-MANUAL'); // must not re-issue
  });

  it('RF03 different amount on completed refund → throws', async () => {
    const id = 'RF-TEST-03';
    _ledger().set(id, {
      returnId: id, amount: 800, status: 'COMPLETED', method: 'original_payment',
      transactionId: 'TXN-X', initiatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(), cancelledAt: null, failureReason: null,
    });
    await assert.rejects(
      initiateRefund({ returnId: id, amount: 900, method: 'original_payment', initiatedBy: 'agent' }),
      /already completed with amount/
    );
  });

  it('RF04 cancel PENDING refund → status becomes CANCELLED', () => {
    const id = 'RF-TEST-04';
    _ledger().set(id, {
      returnId: id, amount: 300, status: 'PENDING', method: 'store_credit',
      transactionId: null, initiatedAt: new Date().toISOString(),
      completedAt: null, cancelledAt: null, failureReason: null,
    });
    const r = cancelRefund(id);
    assert.equal(r.status, 'CANCELLED');
    assert.ok(r.cancelledAt);
  });

  it('RF05 cancel non-PENDING refund → throws', () => {
    const id = 'RF-TEST-05';
    _ledger().set(id, {
      returnId: id, amount: 200, status: 'COMPLETED', method: 'original_payment',
      transactionId: 'TXN-Y', initiatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(), cancelledAt: null, failureReason: null,
    });
    assert.throws(() => cancelRefund(id), /Can only cancel PENDING/);
  });

  it('RF06 getRefund returns null for unknown id', () => {
    assert.equal(getRefund('DOES-NOT-EXIST'), null);
  });
});

// ─── Exception Matrix ─────────────────────────────────────────────────────

describe('Exception Matrix', () => {
  it('EX01 no flags → APPROVE / NO_EXCEPTION', () => {
    const r = evaluateException({});
    assert.equal(r.action, ExceptionAction.APPROVE);
    assert.equal(r.code, 'NO_EXCEPTION');
  });

  it('EX02 fraudFlag → HUMAN_REVIEW', () => {
    const r = evaluateException({ fraudFlag: true });
    assert.equal(r.action, ExceptionAction.HUMAN_REVIEW);
    assert.equal(r.code, 'FRAUD_FLAG');
  });

  it('EX03 addressMismatch → HUMAN_REVIEW', () => {
    const r = evaluateException({ addressMismatch: true });
    assert.equal(r.action, ExceptionAction.HUMAN_REVIEW);
    assert.equal(r.code, 'ADDRESS_MISMATCH');
  });

  it('EX04 warehouseRejection → REJECT', () => {
    const r = evaluateException({ warehouseRejection: true });
    assert.equal(r.action, ExceptionAction.REJECT);
    assert.equal(r.code, 'WAREHOUSE_INSPECTION_FAILED');
  });

  it('EX05 highValue → HUMAN_REVIEW', () => {
    const r = evaluateException({ highValue: true });
    assert.equal(r.action, ExceptionAction.HUMAN_REVIEW);
    assert.equal(r.code, 'HIGH_VALUE_REVIEW');
  });

  it('EX06 priorReturnsCount >= 5 → HUMAN_REVIEW / EXCESSIVE_RETURNS', () => {
    const r = evaluateException({ priorReturnsCount: 5 });
    assert.equal(r.action, ExceptionAction.HUMAN_REVIEW);
    assert.equal(r.code, 'EXCESSIVE_RETURNS');
  });

  it('EX07 priorReturnsCount = 4 → no exception', () => {
    const r = evaluateException({ priorReturnsCount: 4 });
    assert.equal(r.action, ExceptionAction.APPROVE);
  });

  it('EX08 refundGatewayFailed + retryCount >= 3 → HUMAN_REVIEW', () => {
    const r = evaluateException({ refundGatewayFailed: true, refundRetryCount: 3 });
    assert.equal(r.action, ExceptionAction.HUMAN_REVIEW);
    assert.equal(r.code, 'REFUND_GATEWAY_PERSISTENT_FAILURE');
  });

  it('EX09 promptInjection → HUMAN_REVIEW (highest priority)', () => {
    const r = evaluateException({ promptInjection: true, fraudFlag: true, warehouseRejection: true });
    assert.equal(r.action, ExceptionAction.HUMAN_REVIEW);
    assert.equal(r.code, 'PROMPT_INJECTION_DETECTED');
  });

  it('EX10 beauty with no photo → PHOTO_EVIDENCE_MISSING', () => {
    const r = evaluateException({ policyKey: 'beauty', photoEvidence: false });
    assert.equal(r.action, ExceptionAction.HUMAN_REVIEW);
    assert.equal(r.code, 'PHOTO_EVIDENCE_MISSING');
  });
});
