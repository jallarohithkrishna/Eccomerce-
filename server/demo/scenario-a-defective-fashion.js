#!/usr/bin/env node

/**
 * Demo Scenario A — Defective Fashion Item Within Window
 *
 * Flow:
 * 1. Customer initiates return on defective fashion shirt (within 14-day window).
 * 2. Agent checks eligibility -> ELIGIBLE -> Auto-approved with RMA.
 * 3. Reverse carrier label generated & pickup slot booked (PICKUP_SCHEDULED).
 * 4. Package handed to courier -> IN_TRANSIT.
 * 5. Warehouse receives item -> RECEIVED -> item passes inspection -> INSPECTING.
 * 6. Automated payment refund issued -> REFUNDED.
 *
 * Usage:
 *   node server/demo/scenario-a-defective-fashion.js
 */

import { transitionReturn } from '../returns/stateMachine.js';
import { evaluate } from '../policy/engine.js';
import { generateLabel, bookPickupSlot, emitTrackingEvent } from '../services/carrier.js';
import { receiveItem, inspectItem } from '../services/warehouse.js';
import { issueRefund } from '../services/payments.js';
import { notify } from '../services/notifier.js';
import { GENESIS_HASH } from '../returns/audit.js';

export async function runScenarioA({ logger = console.log } = {}) {
  logger('\n───────────────────────────────────────────────────────────────────────────────');
  logger('  DEMO SCENARIO A: Defective Fashion Item In-Window (Auto-Approve to Refund)');
  logger('───────────────────────────────────────────────────────────────────────────────\n');

  const orderId = 'ORD-FASHION-DEFECTIVE-IN-WIN';
  const customerUid = 'demo_cust_a';
  const returnId = 'ret_demo_scen_a';
  let previousHash = GENESIS_HASH;

  // Step 1: Policy Evaluation
  logger('Step 1: Customer requests return for cotton shirt with torn seam (delivered 2 days ago)...');
  const now = new Date();
  const deliveredAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

  const eligibility = evaluate({
    category: 'fashion',
    itemName: 'Slim Fit Cotton Casual Shirt',
    deliveredAt,
    requestedAt: now.toISOString(),
    itemPrice: 1499,
    quantity: 1,
    reason: 'Defective stitching along sleeve',
    photoProvided: true,
    tagsAttached: true,
  });

  logger(`  ✓ Policy Engine Result: eligible=${eligibility.eligible}, decision=${eligibility.decisionCode}`);
  if (!eligibility.eligible) throw new Error('Expected eligible for Scenario A');

  // Step 2: Auto-Approval & RMA Generation
  logger('\nStep 2: Creating return case in state machine...');
  let currentDoc = {
    id: returnId,
    order_id: orderId,
    customer_id: customerUid,
    status: 'NEEDS_INFO',
    item_price: 1499,
  };

  const t1 = transitionReturn({
    returnDoc: currentDoc,
    action: 'APPROVE',
    actor: 'agent',
    data: { rma: 'RMA-A-DEMO-2026', resolution: 'refund' },
    returnId,
    previousHash,
  });
  currentDoc = t1.updatedDoc;
  previousHash = t1.auditEvent.hash;
  logger(`  ✓ Return Approved! Status: ${currentDoc.status} | RMA: ${currentDoc.rma_number}`);

  // Step 3: Carrier Label & Pickup Booking
  logger('\nStep 3: Carrier reverse logistics booking...');
  const label = await generateLabel({ returnId, orderId });
  const slot = await bookPickupSlot({ returnId, preferredDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
  logger(`  ✓ Carrier Label Created: ${label.labelId} (${label.carrier})`);
  logger(`  ✓ Pickup Slot Booked: ${slot.slot}`);

  const t2 = transitionReturn({
    returnDoc: currentDoc,
    action: 'SCHEDULE_PICKUP',
    actor: 'carrier_service',
    data: { slotId: slot.slotId, trackingNumber: label.trackingNumber },
    returnId,
    previousHash,
  });
  currentDoc = t2.updatedDoc;
  previousHash = t2.auditEvent.hash;
  logger(`  ✓ Status advanced to: ${currentDoc.status}`);

  // Step 4: Carrier Pickup & In-Transit
  logger('\nStep 4: Courier scans package on customer pickup...');
  await emitTrackingEvent({ returnId, event: 'PACKAGE_PICKED_UP' });
  const t3 = transitionReturn({
    returnDoc: currentDoc,
    action: 'PICKUP_COMPLETE',
    actor: 'carrier_service',
    data: { scannedAt: new Date().toISOString() },
    returnId,
    previousHash,
  });
  currentDoc = t3.updatedDoc;
  previousHash = t3.auditEvent.hash;
  logger(`  ✓ Status advanced to: ${currentDoc.status}`);

  // Step 5: Warehouse Receipt & Inspection
  logger('\nStep 5: Warehouse intake & physical inspection...');
  const receipt = await receiveItem({ returnId });
  logger(`  ✓ Warehouse Received: doc ${receipt.receiptId} at ${receipt.receivedAt}`);

  const t4 = transitionReturn({
    returnDoc: currentDoc,
    action: 'RECEIVE',
    actor: 'warehouse_service',
    data: receipt,
    returnId,
    previousHash,
  });
  currentDoc = t4.updatedDoc;
  previousHash = t4.auditEvent.hash;
  logger(`  ✓ Status: ${currentDoc.status}`);

  const inspectRes = await inspectItem({ returnId, outcome: 'pass', condition: 'defect_confirmed' });
  logger(`  ✓ Inspection complete: outcome=${inspectRes.outcome}, eligible=${inspectRes.refundEligible}`);

  const t5 = transitionReturn({
    returnDoc: currentDoc,
    action: 'INSPECT',
    actor: 'warehouse_service',
    data: inspectRes,
    returnId,
    previousHash,
  });
  currentDoc = t5.updatedDoc;
  previousHash = t5.auditEvent.hash;
  logger(`  ✓ Status advanced to: ${currentDoc.status}`);

  // Step 6: Automated Refund Issuance
  logger('\nStep 6: Payment gateway refund dispatch...');
  const refundRes = await issueRefund({ returnId, orderId, amount: 1499 });
  logger(`  ✓ Payment Gateway Refund: ${refundRes.refundId} (status: ${refundRes.status})`);

  // Advance through REFUND_PROCESSING (required intermediate state)
  const t6a = transitionReturn({
    returnDoc: currentDoc,
    toState: 'REFUND_PROCESSING',
    action: 'REFUND_SUCCESS',
    actor: 'payment_service',
    data: { idempotencyKey: refundRes.refundId },
    returnId,
    previousHash,
  });
  currentDoc = t6a.updatedDoc;
  previousHash = t6a.auditEvent.hash;
  logger(`  ✓ Status: ${currentDoc.status}`);

  const t6 = transitionReturn({
    returnDoc: currentDoc,
    action: 'REFUND_SUCCESS',
    actor: 'payment_service',
    data: refundRes,
    returnId,
    previousHash,
  });
  currentDoc = t6.updatedDoc;
  previousHash = t6.auditEvent.hash;
  logger(`  ✓ Final Return Status: ${currentDoc.status} 🎉`);


  await notify({
    returnId,
    customerUid,
    title: 'Refund Processed',
    body: '₹1499 has been refunded to your original payment method.',
  });
  logger('  ✓ Customer notification sent: in-app + email.');

  return { success: true, finalStatus: currentDoc.status, rma: currentDoc.rma_number };
}

if (process.argv[1] && process.argv[1].endsWith('scenario-a-defective-fashion.js')) {
  runScenarioA().then(() => process.exit(0)).catch(err => {
    console.error('Scenario A failed:', err);
    process.exit(1);
  });
}
