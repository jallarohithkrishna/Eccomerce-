#!/usr/bin/env node

/**
 * Demo Scenario D — High-Value Luxury Item (₹60,000) Human Review Routing
 *
 * Flow:
 * 1. Customer initiates return for luxury Swiss watch valued at ₹60,000.
 * 2. Policy engine flags item: itemPrice (₹60,000) > threshold (₹50,000).
 * 3. Immediate rule enforcement: requiresHumanReview = true (auto-approval STRICTLY forbidden).
 * 4. State transitions: NEEDS_INFO -> HUMAN_REVIEW with complete case packet.
 * 5. High-priority alert written to alerts collection for staff supervisor.
 *
 * Usage:
 *   node server/demo/scenario-d-luxury-human-review.js
 */

import { transitionReturn } from '../returns/stateMachine.js';
import { evaluate } from '../policy/engine.js';
import { notify } from '../services/notifier.js';
import { GENESIS_HASH } from '../returns/audit.js';

export async function runScenarioD({ logger = console.log } = {}) {
  logger('\n───────────────────────────────────────────────────────────────────────────────');
  logger('  DEMO SCENARIO D: Luxury Watch (₹60,000) -> Mandatory Human Review & Case Packet');
  logger('───────────────────────────────────────────────────────────────────────────────\n');

  const orderId = 'ORD-LUX-60K-HUMAN-REVIEW';
  const customerUid = 'demo_cust_a';
  const returnId = 'ret_demo_scen_d';
  const itemPrice = 60000;
  let previousHash = GENESIS_HASH;

  // Step 1: Policy Evaluation with High-Value Trigger
  logger(`Step 1: Customer requests return for luxury watch (Item Price: ₹${itemPrice.toLocaleString('en-IN')})...`);
  const now = new Date();
  const deliveredAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

  const eligibility = evaluate({
    category: 'luxury',
    itemName: 'Heritage Chronograph Automatic Gold Watch',
    deliveredAt,
    requestedAt: now.toISOString(),
    itemPrice,
    quantity: 1,
    reason: 'Wants different strap color',
    photoProvided: true,
  });

  logger(`  ✓ Policy Result: eligible=${eligibility.eligible}, requiresHumanReview=${eligibility.requiresHumanReview}`);
  logger(`  ✓ Reason: ${eligibility.decisionMessage}`);
  if (!eligibility.requiresHumanReview) {
    throw new Error('Expected requiresHumanReview=true for ₹60,000 luxury item');
  }

  // Step 2: Build Case Packet for Human Staff
  logger('\nStep 2: Constructing comprehensive case packet for staff supervisor...');
  const casePacket = {
    orderId,
    customerUid,
    itemPrice,
    currency: 'INR',
    highValueFlag: true,
    authenticityCardsRequired: true,
    originalPackagingRequired: true,
    riskScore: 'MEDIUM_HIGH_VALUE',
    eligibilitySnapshot: eligibility,
    deliveredAt,
    requestedAt: now.toISOString(),
    notes: 'Item exceeds ₹50,000 threshold. Supervisor physical inspection & serial number cross-check mandatory before refund approval.',
  };
  logger('  ✓ Case Packet compiled with fraud prevention checkpoints.');

  // Step 3: Transition to HUMAN_REVIEW (Bypasses any instant auto-approval)
  logger('\nStep 3: State machine routes return to HUMAN_REVIEW...');
  let currentDoc = {
    id: returnId,
    order_id: orderId,
    customer_id: customerUid,
    status: 'NEEDS_INFO',
    item_price: itemPrice,
  };

  const t1 = transitionReturn({
    returnDoc: currentDoc,
    action: 'ESCALATE',
    actor: 'agent',
    data: {
      reason: 'High-value threshold exceeded (₹60,000)',
      casePacket,
    },
    returnId,
    previousHash,
  });
  currentDoc = t1.updatedDoc;
  previousHash = t1.auditEvent.hash;
  logger(`  ✓ Status: ${currentDoc.status} 💎 🛡️`);

  // Step 4: Notify Customer of Specialist Review
  logger('\nStep 4: Customer informed of white-glove specialist review...');
  await notify({
    returnId,
    customerUid,
    title: 'Luxury Concierge Review In Progress',
    body: 'Your luxury return is being reviewed by our specialist team. We will contact you within 24 hours regarding collection & verification.',
  });
  logger('  ✓ Customer received reassurance without false instant approval.');

  return { success: true, finalStatus: currentDoc.status, itemPrice, casePacket };
}

if (process.argv[1] && process.argv[1].endsWith('scenario-d-luxury-human-review.js')) {
  runScenarioD().then(() => process.exit(0)).catch(err => {
    console.error('Scenario D failed:', err);
    process.exit(1);
  });
}
