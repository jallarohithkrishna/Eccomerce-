#!/usr/bin/env node

/**
 * NO-LLM Tool Check Script — Phase D Debug
 * Directly executes agent tools against the seeded emulator with no LLM.
 *
 * Verifies:
 * 1. list_my_orders for uid 'demo_cust_a'
 * 2. get_order for one order
 * 3. check_eligibility for ORD-FASHION-DEFECTIVE-IN-WIN
 * 4. check_eligibility for ORD-FASHION-EXPIRED
 * 5. check_eligibility for ORD-LUX-60K-HUMAN-REVIEW
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { executeTool } from '../agent/tools.js';
import * as session from '../agent/session.js';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

if (!getApps().length) {
  initializeApp({ projectId: 'rrrrr-711b3' });
}
const db = getFirestore();

const uid = 'demo_cust_a';
const conversationId = `check-tools-${Date.now()}`;

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('                 NO-LLM TOOL EXECUTION CHECK — DIRECT EMULATOR                 ');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`Target Firestore:  ${process.env.FIRESTORE_EMULATOR_HOST}`);
  console.log(`User UID:          ${uid}`);
  console.log(`Conversation ID:   ${conversationId}`);
  console.log('───────────────────────────────────────────────────────────────────────────────\n');

  // 1. list_my_orders
  // Pre-create the session so check_eligibility can call session.storeEligibility
  session.getOrCreate(conversationId, uid);

  console.log('▶ [1] Executing tool: list_my_orders');

  const listRes = await executeTool({
    name: 'list_my_orders',
    args: {},
    uid,
    conversationId,
    db,
  });
  console.log('Raw list_my_orders Result:');
  console.log(JSON.stringify(listRes, null, 2));

  // 2. get_order for one result
  const sampleOrderId = listRes.result?.orders?.[0]?.id ||
                        listRes.result?.orders?.[0]?.order_id ||
                        'ORD-FASHION-DEFECTIVE-IN-WIN';
  console.log(`\n▶ [2] Executing tool: get_order (order_id: "${sampleOrderId}")`);
  const getRes = await executeTool({
    name: 'get_order',
    args: { order_id: sampleOrderId },
    uid,
    conversationId,
    db,
  });
  console.log('Raw get_order Result:');
  console.log(JSON.stringify(getRes, null, 2));

  // 3. check_eligibility for ORD-FASHION-DEFECTIVE-IN-WIN
  console.log('\n▶ [3] Executing tool: check_eligibility for ORD-FASHION-DEFECTIVE-IN-WIN');
  const eligShirtRes = await executeTool({
    name: 'check_eligibility',
    args: {
      order_id: 'ORD-FASHION-DEFECTIVE-IN-WIN',
      product_id: 'prod_fashion_shirt',
      quantity: 1,
      reason: 'defect',
      tags_attached: true,
    },
    uid,
    conversationId,
    db,
  });
  console.log('Raw check_eligibility (Shirt Defective In-Window):');
  console.log(JSON.stringify(eligShirtRes, null, 2));

  // 4. check_eligibility for ORD-FASHION-EXPIRED
  console.log('\n▶ [4] Executing tool: check_eligibility for ORD-FASHION-EXPIRED');
  const eligJacketRes = await executeTool({
    name: 'check_eligibility',
    args: {
      order_id: 'ORD-FASHION-EXPIRED',
      product_id: 'prod_fashion_jacket',
      quantity: 1,
      reason: 'defect',
      tags_attached: true,
    },
    uid,
    conversationId,
    db,
  });
  console.log('Raw check_eligibility (Jacket Expired):');
  console.log(JSON.stringify(eligJacketRes, null, 2));

  // 5. check_eligibility for ORD-LUX-60K-HUMAN-REVIEW
  console.log('\n▶ [5] Executing tool: check_eligibility for ORD-LUX-60K-HUMAN-REVIEW');
  const eligWatchRes = await executeTool({
    name: 'check_eligibility',
    args: {
      order_id: 'ORD-LUX-60K-HUMAN-REVIEW',
      product_id: 'prod_lux_watch',
      quantity: 1,
      reason: 'defect',
      authenticity_cards: true,
      original_packaging: true,
    },
    uid,
    conversationId,
    db,
  });
  console.log('Raw check_eligibility (Luxury Watch 60k):');
  console.log(JSON.stringify(eligWatchRes, null, 2));
  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('Fatal error in check-tools.js:', err);
  process.exit(1);
});
