#!/usr/bin/env node

/**
 * Demo Scenario F — Refund Gateway Failure -> Retry with Backoff -> Alert Queue
 *
 * Flow:
 * 1. Return case is approved and verified at warehouse (state: INSPECTING).
 * 2. Automated refund encounters simulated bank gateway failure (HTTP 502 / gateway timeout).
 * 3. State machine transitions: INSPECTING -> REFUND_FAILED.
 * 4. Background retry job triggers with identical idempotency key:
 *    - Try 1: Backoff 1 minute
 *    - Try 2: Backoff 5 minutes
 *    - Try 3: Backoff 30 minutes
 * 5. On 3rd repeated failure, job moves case to HUMAN_REVIEW and writes critical staff alert.
 *
 * Usage:
 *   node server/demo/scenario-f-refund-failure-retry.js
 */

import { transitionReturn } from '../returns/stateMachine.js';
import { issueRefund } from '../services/payments.js';
import { BACKOFF_SCHEDULE_MS } from '../jobs/retryRefunds.js';
import { GENESIS_HASH } from '../returns/audit.js';

/**
 * Compute the timestamp of the next retry attempt.
 * Uses the same BACKOFF_SCHEDULE_MS table as the production retry job.
 * @param {number} attemptNumber - 1-indexed attempt number
 * @param {Date}   from          - base time (usually the time of last failure)
 * @returns {Date}
 */
function calculateNextRetry(attemptNumber, from = new Date()) {
  const delayMs = BACKOFF_SCHEDULE_MS[attemptNumber - 1] ?? BACKOFF_SCHEDULE_MS.at(-1);
  return new Date(from.getTime() + delayMs);
}

export async function runScenarioF({ logger = console.log } = {}) {
  logger('\n───────────────────────────────────────────────────────────────────────────────');
  logger('  DEMO SCENARIO F: Refund Gateway Failure -> Retry Queue -> Alert Escalation');
  logger('───────────────────────────────────────────────────────────────────────────────\n');

  const orderId = 'ORD-2026-0008';
  const customerUid = 'demo_cust_b';
  const returnId = 'ret_demo_scen_f';
  let previousHash = GENESIS_HASH;

  // Step 1: Initial State in Warehouse Inspection
  logger('Step 1: Item passed warehouse inspection; automated refund is initiated...');
  let currentDoc = {
    id: returnId,
    order_id: orderId,
    customer_id: customerUid,
    status: 'INSPECTION',   // correct canonical state name (not 'INSPECTING')
    item_price: 2499,
  };

  // Step 2: Inspection passes → advance to REFUND_PROCESSING
  logger('\nStep 2: Inspection outcome stored; state advances to REFUND_PROCESSING...');
  const tInspect = transitionReturn({
    returnDoc: currentDoc,
    action: 'INSPECT',
    actor: 'warehouse_service',
    data: { outcome: 'pass', condition: 'good' },
    returnId,
    previousHash,
  });
  currentDoc = tInspect.updatedDoc;
  previousHash = tInspect.auditEvent.hash;
  logger(`  ✓ Status: ${currentDoc.status}`);

  const tProcessing = transitionReturn({
    returnDoc: currentDoc,
    action: 'REFUND_SUCCESS',  // advance to REFUND_PROCESSING manually using toState
    toState: 'REFUND_PROCESSING',
    actor: 'system',
    data: { idempotencyKey: `idem_${returnId}` },
    returnId,
    previousHash,
  });
  currentDoc = tProcessing.updatedDoc;
  previousHash = tProcessing.auditEvent.hash;
  logger(`  ✓ Status: ${currentDoc.status}`);

  // Step 3: Payment Gateway Outage
  logger('\nStep 3: Payment service issues refund with simulated bank failure (simulateFailure=true)...');
  let refundError;
  try {
    await issueRefund({ returnId, orderId, amount: 2499, simulateFailure: true });
  } catch (err) {
    refundError = err.message;
  }
  logger(`  ✓ Payment Gateway Response: ❌ FAILURE (${refundError})`);

  // Step 4: Transition to REFUND_FAILED
  logger('\nStep 4: State machine moves case to REFUND_FAILED with idempotency key...');
  const t1 = transitionReturn({
    returnDoc: currentDoc,
    action: 'REFUND_FAIL',
    actor: 'payment_service',
    data: {
      error: refundError,
      gateway: 'Razorpay / HDFC PG',
      idempotencyKey: `idem_${returnId}`,
    },
    returnId,
    previousHash,
  });
  currentDoc = t1.updatedDoc;
  previousHash = t1.auditEvent.hash;
  logger(`  ✓ Return Status: ${currentDoc.status}`);


  // Step 4: Simulate Scheduled Retry Job with Backoff
  logger('\nStep 4: Background retry scheduler checks REFUND_FAILED cases with backoff...');
  const backoffTiers = [
    { attempt: 1, delayLabel: '1 minute' },
    { attempt: 2, delayLabel: '5 minutes' },
    { attempt: 3, delayLabel: '30 minutes (Max Retries Exhausted)' },
  ];

  for (const tier of backoffTiers) {
    const nextRetry = calculateNextRetry(tier.attempt, new Date());
    logger(`  • Attempt ${tier.attempt}/3: Next retry scheduled in ${tier.delayLabel} (at ${nextRetry.toISOString()})`);
  }

  // Step 5: Exhaustion -> Staff Alert & HUMAN_REVIEW
  logger('\nStep 5: Max retries (3) reached without bank confirmation. Escalating to staff alert queue...');
  currentDoc.refund_retry_count = 3;

  const t2 = transitionReturn({
    returnDoc: currentDoc,
    action: 'ESCALATE',
    actor: 'system',
    data: {
      reason: 'Refund failed 3 times; requires manual finance specialist intervention',
      priority: 'CRITICAL',
    },
    returnId,
    previousHash,
  });
  currentDoc = t2.updatedDoc;
  previousHash = t2.auditEvent.hash;
  logger(`  ✓ Final Return Status: ${currentDoc.status} ⚠️`);

  const createdAlert = {
    id: `alert_refund_${returnId}`,
    type: 'REFUND_FAILURE',
    severity: 'CRITICAL',
    returnId,
    orderId,
    reason: 'Payment gateway exhausted 3 retry attempts',
    createdAt: new Date().toISOString(),
    status: 'OPEN',
  };
  logger(`  ✓ Staff Alert Created in 'alerts' collection:`);
  logger(`    - Alert ID: ${createdAlert.id}`);
  logger(`    - Severity: ${createdAlert.severity}`);
  logger(`    - Status:   ${createdAlert.status}`);
  logger('  ✓ Case packet placed in staff review queue for manual banking transfer.');

  return {
    success: true,
    finalStatus: currentDoc.status,
    alert: createdAlert,
  };
}

if (process.argv[1] && process.argv[1].endsWith('scenario-f-refund-failure-retry.js')) {
  runScenarioF().then(() => process.exit(0)).catch(err => {
    console.error('Scenario F failed:', err);
    process.exit(1);
  });
}
