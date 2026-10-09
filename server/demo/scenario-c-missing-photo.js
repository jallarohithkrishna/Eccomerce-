#!/usr/bin/env node

/**
 * Demo Scenario C — Missing Photo Evidence -> Upload -> Resume & Approve
 *
 * Flow:
 * 1. Customer initiates replacement request for face serum without uploading photo.
 * 2. Policy engine requires photo evidence for hygiene/beauty category.
 * 3. Return placed in NEEDS_INFO state; agent requests photo proof of defective seal.
 * 4. Customer uploads photo of damaged bottle/broken seal.
 * 5. Evidence analyzed; return case resumes and transitions: NEEDS_INFO -> APPROVED.
 * 6. Reverse logistics initiated for replacement dispatch.
 *
 * Usage:
 *   node server/demo/scenario-c-missing-photo.js
 */

import { transitionReturn } from '../returns/stateMachine.js';
import { evaluate } from '../policy/engine.js';
import { notify } from '../services/notifier.js';
import { GENESIS_HASH } from '../returns/audit.js';

/**
 * Simulates photo analysis for the demo.
 * In production, the real pipeline uses analyzeEvidence({ imageBuffer, mimeType }) from agent/evidence.js.
 * @param {string} url - a public image URL (demo only)
 * @param {{ category: string, claimedReason: string }} opts
 * @returns {Promise<{ verified: boolean, quality: string, description: string }>}
 */
async function analyzePhoto(url, { category, claimedReason } = {}) {
  // Demo stub — always passes in happy-path demo.
  return {
    verified: true,
    quality: 'pass',
    description: `[DEMO] Simulated analysis of ${category} item photo. Claim "${claimedReason}" is visually supported. Confidence: high`,
    imageUrl: url,
  };
}

export async function runScenarioC({ logger = console.log } = {}) {
  logger('\n───────────────────────────────────────────────────────────────────────────────');
  logger('  DEMO SCENARIO C: Missing Photo -> Agent Asks -> Customer Uploads -> Resume');
  logger('───────────────────────────────────────────────────────────────────────────────\n');

  const orderId = 'ORD-BEAUTY-IN-WIN';
  const customerUid = 'demo_cust_a';
  const returnId = 'ret_demo_scen_c';
  let previousHash = GENESIS_HASH;

  // Step 1: Initial Request without Photo
  logger('Step 1: Customer requests return for face serum claiming leaked bottle, but uploads no photo...');
  const now = new Date();
  const deliveredAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const eligibilityInitial = evaluate({
    category: 'beauty',
    itemName: 'Vitamin C Radiance Face Serum (30ml)',
    deliveredAt,
    requestedAt: now.toISOString(),
    itemPrice: 999,
    quantity: 1,
    reason: 'Bottle seal arrived broken and leaked',
    photoProvided: false, // NO PHOTO
  });

  logger(`  ✓ Policy Check: eligible=${eligibilityInitial.eligible}, decision=${eligibilityInitial.decisionCode}`);
  logger(`  ✓ Policy Condition: ${eligibilityInitial.decisionMessage}`);

  // Step 2: Set status to NEEDS_INFO and request photo
  logger('\nStep 2: Case placed in NEEDS_INFO status. Agent requests photo evidence...');
  let currentDoc = {
    id: returnId,
    order_id: orderId,
    customer_id: customerUid,
    status: 'NEEDS_INFO',
    item_price: 999,
  };

  const t1 = transitionReturn({
    returnDoc: currentDoc,
    action: 'REQUEST_EVIDENCE',
    actor: 'agent',
    data: {
      requiredEvidence: ['photo_of_broken_seal', 'batch_code_photo'],
      message: 'Please upload a photo showing the damaged cap and leaked liquid to proceed.',
    },
    returnId,
    previousHash,
  });
  currentDoc = t1.updatedDoc;
  previousHash = t1.auditEvent.hash;
  logger(`  ✓ Return Status: ${currentDoc.status}`);

  await notify({
    returnId,
    customerUid,
    title: 'Photo Evidence Needed',
    body: 'Please upload a clear photo of the damaged seal on your face serum to authorize replacement.',
  });
  logger('  ✓ In-app prompt and email sent to customer with upload link.');

  // Step 3: Customer Uploads Photo
  logger('\nStep 3: Customer uploads photo evidence...');
  const samplePhotoUrl = 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be';
  const analysis = await analyzePhoto(samplePhotoUrl, { category: 'beauty', claimedReason: 'leaked_seal' });
  logger(`  ✓ Photo Analysis: verified=${analysis.verified || true}, quality=${analysis.quality || 'pass'}`);

  // Step 4: Re-evaluate with Photo Evidence
  logger('\nStep 4: Re-evaluating policy with verified evidence...');
  const eligibilityWithPhoto = evaluate({
    category: 'beauty',
    itemName: 'Vitamin C Radiance Face Serum (30ml)',
    deliveredAt,
    requestedAt: now.toISOString(),
    itemPrice: 999,
    quantity: 1,
    reason: 'Bottle seal arrived broken and leaked',
    photoProvided: true, // PHOTO NOW PROVIDED
  });
  logger(`  ✓ Re-evaluation: eligible=${eligibilityWithPhoto.eligible}, decision=${eligibilityWithPhoto.decisionCode}`);

  // Step 5: Resume & Approve
  logger('\nStep 5: Case resumes and transitions from NEEDS_INFO to APPROVED...');
  const t2 = transitionReturn({
    returnDoc: currentDoc,
    action: 'APPROVE',
    actor: 'agent',
    data: {
      rma: 'RMA-C-REPLACE-SERUM',
      resolution: 'replacement',
      evidenceVerified: true,
      photoUrl: samplePhotoUrl,
    },
    returnId,
    previousHash,
  });
  currentDoc = t2.updatedDoc;
  previousHash = t2.auditEvent.hash;
  logger(`  ✓ Final Return Status: ${currentDoc.status} (RMA: ${currentDoc.rma_number}) 📸 ✅`);

  return { success: true, finalStatus: currentDoc.status, rma: currentDoc.rma_number };
}

if (process.argv[1] && process.argv[1].endsWith('scenario-c-missing-photo.js')) {
  runScenarioC().then(() => process.exit(0)).catch(err => {
    console.error('Scenario C failed:', err);
    process.exit(1);
  });
}
