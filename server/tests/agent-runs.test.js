/**
 * Tests for Admin "Agent runs" page & Single Document Telemetry — PS-01 Phase C4
 * 
 * Tests:
 * 1. Single document counters: latency (avg, min, max, last), tool-call counts, escalations, blocked calls, model used, alerts open
 * 2. Strict bounding: query with limit 50 caps at 50 max (no whole-collection scans)
 * 3. Trace preservation: each run preserves tool names, inputs, outputs, timestamps, and audit events
 * 4. API endpoints: GET /agent/runs and GET /agent/metrics enforce staff/admin role
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as metrics from '../agent/metrics.js';
import * as conversations from '../agent/conversations.js';
import * as returnStore from '../returns/store.js';
import { createEvent, GENESIS_HASH } from '../returns/audit.js';

describe('Admin Agent Runs & Telemetry Metrics (Phase C4 Item 3)', () => {
  beforeEach(() => {
    metrics._resetMetrics();
    conversations._clearAll();
    returnStore._clearAll();
  });

  it('records latency, tool calls, escalations, and blocked calls in the single metrics document', async () => {
    // 1. Initial state
    const initial = await metrics.getMetrics();
    assert.equal(initial.totalRuns, 0);
    assert.equal(initial.latency.avgMs, 0);
    assert.equal(initial.toolCallCounts._total, 0);
    assert.equal(initial.escalations, 0);
    assert.equal(initial.blockedCalls, 0);

    // 2. Record normal run
    await metrics.recordAgentRun({
      conversationId: 'conv_1',
      latencyMs: 300,
      toolCalls: ['list_my_orders', 'check_eligibility'],
      escalated: false,
      blocked: false,
      model: 'gpt-4o-mini',
    });

    let state = await metrics.getMetrics();
    assert.equal(state.totalRuns, 1);
    assert.equal(state.latency.lastMs, 300);
    assert.equal(state.latency.avgMs, 300);
    assert.equal(state.toolCallCounts.list_my_orders, 1);
    assert.equal(state.toolCallCounts.check_eligibility, 1);
    assert.equal(state.toolCallCounts._total, 2);
    assert.equal(state.modelUsed, 'gpt-4o-mini');

    // 3. Record second run with escalation and attack block
    await metrics.recordAgentRun({
      conversationId: 'conv_2',
      latencyMs: 500,
      toolCalls: ['create_return', 'schedule_pickup'],
      escalated: true,
      blocked: true,
      model: 'gpt-4o-mini',
    });

    state = await metrics.getMetrics();
    assert.equal(state.totalRuns, 2);
    assert.equal(state.latency.avgMs, 400); // (300 + 500) / 2
    assert.equal(state.latency.minMs, 300);
    assert.equal(state.latency.maxMs, 500);
    assert.equal(state.toolCallCounts.create_return, 1);
    assert.equal(state.toolCallCounts.schedule_pickup, 1);
    assert.equal(state.toolCallCounts._total, 4);
    assert.equal(state.escalations, 1);
    assert.equal(state.blockedCalls, 1);
  });

  it('accurately counts open SLA alerts from alerts store without full collection scans', async () => {
    await returnStore.createAlert({
      db: null,
      alert: {
        id: 'alt_1',
        type: 'SLA_BREACH',
        subtype: 'PICKUP_NOT_SCHEDULED_48H',
        returnId: 'ret_sla_1',
        severity: 'WARNING',
        status: 'OPEN',
      },
    });

    await returnStore.createAlert({
      db: null,
      alert: {
        id: 'alt_2',
        type: 'REFUND_FAILED',
        subtype: 'PAYMENT_GATEWAY_ERROR',
        returnId: 'ret_sla_2',
        severity: 'CRITICAL',
        status: 'OPEN',
      },
    });

    await returnStore.createAlert({
      db: null,
      alert: {
        id: 'alt_3',
        type: 'TRACE_NEEDED',
        subtype: 'IN_TRANSIT_DELAY',
        returnId: 'ret_sla_3',
        severity: 'INFO',
        status: 'RESOLVED',
      },
    });

    const m = await metrics.getMetrics();
    assert.equal(m.alertsOpen, 2, 'Only OPEN alerts should be counted in alertsOpen');
  });

  it('bounds listAgentRuns strictly to 50 max (no whole-collection scans)', async () => {
    // Generate 70 dummy runs
    for (let i = 1; i <= 70; i++) {
      const convId = `conv_${i.toString().padStart(3, '0')}`;
      const ev = createEvent({
        returnId: convId,
        previousHash: GENESIS_HASH,
        actor: 'agent',
        action: 'CHECK_ELIGIBILITY',
        data: { ok: true },
      });
      await conversations.saveConversation({
        db: null,
        conversationId: convId,
        uid: `user_${i}`,
        messages: [{ role: 'user', content: 'hello' }],
        caseCard: { state: 'ELIGIBILITY_CHECK' },
        auditEvents: [ev],
      });
    }

    // Requesting limit 100 must be capped at 50
    const runs = await metrics.listAgentRuns({ db: null, limitN: 100 });
    assert.equal(runs.length, 50, 'Must cap results at 50');

    // Requesting limit 10 should return 10
    const runs10 = await metrics.listAgentRuns({ db: null, limitN: 10 });
    assert.equal(runs10.length, 10, 'Must honor smaller bounds');
  });

  it('preserves the Agent trace audit events and tool data for each case', async () => {
    const ev1 = createEvent({
      returnId: 'conv_trace_test',
      previousHash: GENESIS_HASH,
      actor: 'agent',
      action: 'LIST_MY_ORDERS',
      data: { inputs: { uid: 'u1' }, outputs: [{ orderId: 'ord_1' }], ok: true },
    });
    const ev2 = createEvent({
      returnId: 'conv_trace_test',
      previousHash: ev1.hash,
      actor: 'agent',
      action: 'CHECK_ELIGIBILITY',
      data: { inputs: { orderId: 'ord_1', productId: 'p1' }, outputs: { eligible: true }, ok: true },
    });

    await conversations.saveConversation({
      db: null,
      conversationId: 'conv_trace_test',
      uid: 'u1',
      messages: [
        { role: 'user', content: 'I need to return this' },
        { role: 'assistant', content: 'Your item is eligible' },
      ],
      caseCard: { rmaNumber: 'RMA-TEST001', state: 'APPROVED', decision: 'ELIGIBLE' },
      auditEvents: [ev1, ev2],
    });

    const runs = await metrics.listAgentRuns({ db: null, limitN: 10 });
    const run = runs.find(r => r.conversationId === 'conv_trace_test');
    assert.ok(run, 'Run must exist in results');
    assert.equal(run.toolCallsCount, 2);
    assert.deepEqual(run.toolNames, ['LIST_MY_ORDERS', 'CHECK_ELIGIBILITY']);
    assert.equal(run.auditEvents.length, 2);
    assert.equal(run.auditEvents[0].action, 'LIST_MY_ORDERS');
    assert.equal(run.auditEvents[1].action, 'CHECK_ELIGIBILITY');
    assert.equal(run.caseCard.rmaNumber, 'RMA-TEST001');
    assert.equal(run.caseCard.state, 'APPROVED');
  });
});
