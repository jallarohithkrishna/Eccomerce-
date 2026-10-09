/**
 * Demo Scenarios Test Suite — PS-01 Phase C4
 *
 * Verifies that all 6 demo scenarios execute cleanly end-to-end:
 *   (a) Defective fashion item in window: auto-approved, pickup booked, refunded
 *   (b) Outside window: denied, appeal, human review
 *   (c) Missing photo: agent asks, customer uploads, resumes
 *   (d) Luxury item at 60000: human review with case packet
 *   (e) Prompt injection: ignored, visible in the audit trail
 *   (f) Refund gateway failure: retry, then alert queue
 *
 * Run: node --test tests/demo-scenarios.test.js
 */

import { strict as assert } from 'assert';
import { describe, it } from 'node:test';

import { runScenarioA } from '../demo/scenario-a-defective-fashion.js';
import { runScenarioB } from '../demo/scenario-b-outside-window-appeal.js';
import { runScenarioC } from '../demo/scenario-c-missing-photo.js';
import { runScenarioD } from '../demo/scenario-d-luxury-human-review.js';
import { runScenarioE } from '../demo/scenario-e-prompt-injection.js';
import { runScenarioF } from '../demo/scenario-f-refund-failure-retry.js';
import { runAllDemoScenarios } from '../demo/run-all.js';

const silentLogger = () => {};

describe('Phase C4 Demo Scenarios Suite (6 End-to-End Scenarios)', () => {
  it('DEMO-A: defective fashion item in window auto-approves, schedules pickup, inspects, and refunds', async () => {
    const res = await runScenarioA({ logger: silentLogger });
    assert.equal(res.success, true);
    assert.equal(res.finalStatus, 'COMPLETED'); // canonical terminal state after successful refund
    assert.ok(res.rma.startsWith('RMA-A-'));
  });

  it('DEMO-B: outside window denies return, accepts customer appeal, and routes to human review', async () => {
    const res = await runScenarioB({ logger: silentLogger });
    assert.equal(res.success, true);
    assert.equal(res.finalStatus, 'HUMAN_REVIEW');
    assert.ok(res.reason.includes('hospitalized'));
  });

  it('DEMO-C: missing photo prompts for evidence, ingests upload, and resumes approval', async () => {
    const res = await runScenarioC({ logger: silentLogger });
    assert.equal(res.success, true);
    assert.equal(res.finalStatus, 'APPROVED');
    assert.ok(res.rma.startsWith('RMA-C-'));
  });

  it('DEMO-D: luxury item at ₹60,000 blocks auto-approval and generates case packet for human review', async () => {
    const res = await runScenarioD({ logger: silentLogger });
    assert.equal(res.success, true);
    assert.equal(res.finalStatus, 'HUMAN_REVIEW');
    assert.equal(res.itemPrice, 60000);
    assert.ok(res.casePacket.authenticityCardsRequired);
  });

  it('DEMO-E: prompt injection is ignored, blocked from tools, and hashed in audit trail', async () => {
    const res = await runScenarioE({ logger: silentLogger });
    assert.equal(res.success, true);
    assert.equal(res.blocked, true);
    assert.ok(res.auditHash && res.auditHash.length === 64, 'Must produce SHA-256 event hash');
  });

  it('DEMO-F: refund failure advances to REFUND_FAILED, retries with backoff, and escalates to alert queue', async () => {
    const res = await runScenarioF({ logger: silentLogger });
    assert.equal(res.success, true);
    assert.equal(res.finalStatus, 'HUMAN_REVIEW');
    assert.equal(res.alert.severity, 'CRITICAL');
  });

  it('DEMO-ALL: orchestrator runs all 6 scenarios and reports 100% pass rate', async () => {
    const { allPassed, results } = await runAllDemoScenarios();
    assert.equal(allPassed, true);
    assert.equal(results.length, 6);
  });
});
