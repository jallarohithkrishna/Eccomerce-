#!/usr/bin/env node

/**
 * PS-01 Demo Suite Runner — Runs All 6 Scenarios End-to-End
 *
 * Runs:
 *   (a) Defective fashion item in window: auto-approved, pickup booked, refunded
 *   (b) Outside window: denied, appeal, human review
 *   (c) Missing photo: agent asks, customer uploads, resumes
 *   (d) Luxury item at 60000: human review with case packet
 *   (e) Prompt injection: ignored, visible in the audit trail
 *   (f) Refund gateway failure: retry, then alert queue
 *
 * Usage:
 *   node server/demo/run-all.js
 */

import { runScenarioA } from './scenario-a-defective-fashion.js';
import { runScenarioB } from './scenario-b-outside-window-appeal.js';
import { runScenarioC } from './scenario-c-missing-photo.js';
import { runScenarioD } from './scenario-d-luxury-human-review.js';
import { runScenarioE } from './scenario-e-prompt-injection.js';
import { runScenarioF } from './scenario-f-refund-failure-retry.js';

export async function runAllDemoScenarios() {
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('              NOVA STORE (PS-01) — 6 LIVE DEMO SCENARIOS RUNNER                ');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const results = [];

  try {
    const rA = await runScenarioA();
    results.push({ name: 'Scenario A: Defective fashion item in-window', outcome: `Auto-Approved -> ${rA.finalStatus}`, passed: rA.success });
  } catch (e) {
    results.push({ name: 'Scenario A: Defective fashion item in-window', outcome: e.message, passed: false });
  }

  try {
    const rB = await runScenarioB();
    results.push({ name: 'Scenario B: Outside window -> appeal', outcome: `Appealed -> ${rB.finalStatus}`, passed: rB.success });
  } catch (e) {
    results.push({ name: 'Scenario B: Outside window -> appeal', outcome: e.message, passed: false });
  }

  try {
    const rC = await runScenarioC();
    results.push({ name: 'Scenario C: Missing photo evidence', outcome: `Resumed -> ${rC.finalStatus}`, passed: rC.success });
  } catch (e) {
    results.push({ name: 'Scenario C: Missing photo evidence', outcome: e.message, passed: false });
  }

  try {
    const rD = await runScenarioD();
    results.push({ name: 'Scenario D: Luxury item at ₹60,000', outcome: `Case Packet -> ${rD.finalStatus}`, passed: rD.success });
  } catch (e) {
    results.push({ name: 'Scenario D: Luxury item at ₹60,000', outcome: e.message, passed: false });
  }

  try {
    const rE = await runScenarioE();
    results.push({ name: 'Scenario E: Prompt injection attack', outcome: `Blocked (Hash: ${rE.auditHash.slice(0, 10)}...)`, passed: rE.success });
  } catch (e) {
    results.push({ name: 'Scenario E: Prompt injection attack', outcome: e.message, passed: false });
  }

  try {
    const rF = await runScenarioF();
    results.push({ name: 'Scenario F: Refund gateway failure & retry', outcome: `3 Retries -> Alert Queue (${rF.finalStatus})`, passed: rF.success });
  } catch (e) {
    results.push({ name: 'Scenario F: Refund gateway failure & retry', outcome: e.message, passed: false });
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('                          DEMO SUITE EXECUTION SUMMARY                         ');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' #  Scenario Name                                Outcome                  Status');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  results.forEach((r, idx) => {
    const num = `${idx + 1}.`.padEnd(3, ' ');
    const name = r.name.padEnd(44, ' ');
    const out = r.outcome.padEnd(25, ' ');
    const stat = r.passed ? '✅ PASS' : '❌ FAIL';
    console.log(` ${num} ${name} ${out} ${stat}`);
  });
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const allPassed = results.every(r => r.passed);
  return { allPassed, results };
}

if (process.argv[1] && process.argv[1].endsWith('run-all.js')) {
  runAllDemoScenarios().then(({ allPassed }) => {
    process.exit(allPassed ? 0 : 1);
  }).catch(err => {
    console.error('Fatal error running demo suite:', err);
    process.exit(1);
  });
}
