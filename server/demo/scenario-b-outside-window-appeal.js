#!/usr/bin/env node

/**
 * Demo Scenario B — Outside Return Window then Appeal
 *
 * Flow:
 * 1. Customer attempts to return denim jacket delivered 35 days ago (14-day window).
 * 2. Policy engine evaluates -> INELIGIBLE (WINDOW_EXPIRED).
 * 3. Return created in REJECTED state; customer informed of policy rules and appeal option.
 * 4. Customer submits appeal citing exceptional circumstance (hospitalization delay).
 * 5. State transitions: REJECTED -> APPEALED -> HUMAN_REVIEW.
 * 6. Audit event chained; case queued on staff dashboard for human decision.
 *
 * Usage:
 *   node server/demo/scenario-b-outside-window-appeal.js
 */

import { transitionReturn } from '../returns/stateMachine.js';
import { evaluate } from '../policy/engine.js';
import { notify } from '../services/notifier.js';
import { GENESIS_HASH } from '../returns/audit.js';

export async function runScenarioB({ logger = console.log } = {}) {
  logger('\n───────────────────────────────────────────────────────────────────────────────');
  logger('  DEMO SCENARIO B: Outside Window Return -> Denial -> Appeal -> Human Review');
  logger('───────────────────────────────────────────────────────────────────────────────\n');

  const orderId = 'ORD-FASHION-EXPIRED';
  const customerUid = 'demo_cust_a';
  const returnId = 'ret_demo_scen_b';
  let previousHash = GENESIS_HASH;

  // Step 1: Policy Engine Check on Expired Order
  logger('Step 1: Customer requests return for denim jacket delivered 35 days ago...');
  const now = new Date();
  const deliveredAt = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000).toISOString();

  const eligibility = evaluate({
    category: 'fashion',
    itemName: 'Vintage Wash Denim Jacket',
    deliveredAt,
    requestedAt: now.toISOString(),
    itemPrice: 3499,
    quantity: 1,
    reason: 'Size does not fit',
    photoProvided: false,
    tagsAttached: true,
  });

  logger(`  ✓ Policy Engine Result: eligible=${eligibility.eligible}, decision=${eligibility.decisionCode}`);
  logger(`  ✓ Reason: ${eligibility.decisionMessage}`);

  // Step 2: Return Denied
  logger('\nStep 2: Creating return case in REJECTED state...');
  let currentDoc = {
    id: returnId,
    order_id: orderId,
    customer_id: customerUid,
    status: 'NEEDS_INFO',
    item_price: 3499,
  };

  const t1 = transitionReturn({
    returnDoc: currentDoc,
    action: 'REJECT',
    actor: 'system',
    data: {
      reason: eligibility.decisionMessage,
      decisionCode: eligibility.decisionCode,
      appealAllowed: true,
    },
    returnId,
    previousHash,
  });
  currentDoc = t1.updatedDoc;
  previousHash = t1.auditEvent.hash;
  logger(`  ✓ Status: ${currentDoc.status}`);

  await notify({
    returnId,
    customerUid,
    title: 'Return Window Expired',
    body: 'Your order was delivered 35 days ago (14-day limit). You may file an appeal if extenuating circumstances apply.',
  });
  logger('  ✓ Customer notified of rejection and appeal rights.');

  // Step 3: Customer Files Appeal
  logger('\nStep 3: Customer submits formal appeal with supporting reasoning...');
  const appealReason = 'I was hospitalized for emergency surgery from day 5 to day 30. Medical discharge summary available.';

  const t2 = transitionReturn({
    returnDoc: currentDoc,
    action: 'APPEAL',
    actor: 'customer',
    data: {
      appealReason,
      submittedAt: new Date().toISOString(),
    },
    returnId,
    previousHash,
  });
  currentDoc = t2.updatedDoc;
  previousHash = t2.auditEvent.hash;
  logger(`  ✓ Status: ${currentDoc.status}`);

  // Step 4: System Escalates to Human Review
  logger('\nStep 4: System routes appealed case to staff review queue...');
  const t3 = transitionReturn({
    returnDoc: currentDoc,
    action: 'ESCALATE',
    actor: 'system',
    data: {
      reason: 'Customer filed formal appeal on expired return',
      priority: 'medium',
    },
    returnId,
    previousHash,
  });
  currentDoc = t3.updatedDoc;
  previousHash = t3.auditEvent.hash;
  logger(`  ✓ Final Return Status: ${currentDoc.status} 📋`);
  logger('  ✓ Case packet prepared and visible on staff dashboard (/admin/returns).');

  return { success: true, finalStatus: currentDoc.status, reason: appealReason };
}

if (process.argv[1] && process.argv[1].endsWith('scenario-b-outside-window-appeal.js')) {
  runScenarioB().then(() => process.exit(0)).catch(err => {
    console.error('Scenario B failed:', err);
    process.exit(1);
  });
}
