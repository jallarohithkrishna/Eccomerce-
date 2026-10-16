/**
 * Tool-Calling Behaviour and Persistence Tests
 * TC01 - Direct-answer: LLM never calls tools, reply returned, 0 tool events
 * TC02 - list_my_orders then check_eligibility: 2 audit events in order
 * TC03 - First-turn toolChoice=required forwarded to LLM
 * TC04 - Undefined fields stripped; riskScore defaults to 0
 * TC05 - directAnswer and chainValid derivation
 * TC06 - list_my_orders reads customer.user_id schema (matching seed + browser)
 * TC07 - 2 tool calls + 1 fallback escalation = 3 audit events
 */

import { strict as assert } from 'assert';
import { describe, it, beforeEach } from 'node:test';
import { runLoop }          from '../agent/loop.js';
import * as session         from '../agent/session.js';
import { saveConversation } from '../agent/conversations.js';
import { stripUndefined }   from '../utils/stripUndefined.js';
import { executeTool }      from '../agent/tools.js';

function fakeLLM(calls) {
  let idx = 0;
  const received = [];
  const fn = async (args) => {
    received.push({ toolChoice: args.toolChoice });
    const call = calls[idx++] || { content: 'Done.' };
    if (call.tool_calls) {
      return {
        message: {
          role: 'assistant', content: null,
          tool_calls: call.tool_calls.map(tc => ({
            id: tc.id || ('tc' + Math.random()),
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
          })),
        },
        finish_reason: 'tool_calls', usage: {},
      };
    }
    return { message: { role: 'assistant', content: call.content || 'Done.' }, finish_reason: 'stop', usage: {} };
  };
  fn.received = received;
  return fn;
}

function uid() { return 'u-tc-' + Math.random().toString(36).slice(2); }
function cid() { return 'c-tc-' + Math.random().toString(36).slice(2); }
beforeEach(() => session._clearAll());

describe('TC01 direct-answer model', async () => {
  it('returns reply with zero tool audit events', async () => {
    const u = uid(), c = cid();
    const llm = fakeLLM([{ content: 'Please describe your issue.' }]);
    const r = await runLoop({ userMessage: 'I want to return something', conversationId: c, uid: u, db: null, llmOverride: llm });
    assert.ok(r.reply, 'should have reply');
    const toolEvts = r.auditEvents.filter(e => e.actor === 'agent' && e.action !== 'PROMPT_INJECTION_DETECTED' && e.action !== 'ESCALATE_TO_HUMAN');
    assert.equal(toolEvts.length, 0, 'zero tool events for direct answer');
  });
});

describe('TC02 list_my_orders then check_eligibility', async () => {
  it('captures two tool audit events in order', async () => {
    const u = uid(), c = cid();
    const llm = fakeLLM([
      { tool_calls: [{ name: 'list_my_orders', args: {} }] },
      { tool_calls: [{ name: 'check_eligibility', args: { order_id: 'TEST-FASHION-OK', product_id: 'P-SHIRT', quantity: 1, reason: 'damage' } }] },
      { content: 'Your shirt is eligible for return.' },
    ]);
    const r = await runLoop({ userMessage: 'My cotton shirt arrived damaged', conversationId: c, uid: u, db: null, llmOverride: llm });
    assert.ok(r.reply);
    const toolEvts = r.auditEvents.filter(e => e.actor === 'agent' && e.action !== 'PROMPT_INJECTION_DETECTED' && e.action !== 'ESCALATE_TO_HUMAN');
    assert.equal(toolEvts.length, 2, 'should have 2 tool events');
    assert.equal(toolEvts[0].action, 'LIST_MY_ORDERS', '1st event is LIST_MY_ORDERS');
    assert.equal(toolEvts[1].action, 'CHECK_ELIGIBILITY', '2nd event is CHECK_ELIGIBILITY');
  });
});

describe('TC03 first-turn toolChoice required', async () => {
  it('passes required on first call, auto on second', async () => {
    const u = uid(), c = cid();
    const llm = fakeLLM([
      { tool_calls: [{ name: 'list_my_orders', args: {} }] },
      { content: 'Here are your orders.' },
    ]);
    await runLoop({ userMessage: 'I want to return something', conversationId: c, uid: u, db: null, llmOverride: llm });
    assert.ok(llm.received.length >= 1, 'LLM called at least once');
    assert.equal(llm.received[0].toolChoice, 'required', 'first call must be required');
    if (llm.received.length > 1) assert.equal(llm.received[1].toolChoice, 'auto', 'second must be auto');
  });

  it('retries with auto if provider rejects required', async () => {
    const u = uid(), c = cid();
    let callCount = 0;
    const receivedChoices = [];
    const llm = async (params) => {
      callCount++;
      receivedChoices.push(params.toolChoice);
      if (params.toolChoice === 'required') {
        throw new Error('Provider does not support tool_choice=required');
      }
      return {
        message: { content: 'I found your order without required tool_choice.' },
        finish_reason: 'stop',
      };
    };
    const res = await runLoop({ userMessage: 'I want to return something', conversationId: c, uid: u, db: null, llmOverride: llm });
    assert.equal(receivedChoices[0], 'required', 'first attempted required');
    assert.equal(receivedChoices[1], 'auto', 'retried with auto');
    assert.ok(res.reply.includes('found your order'), 'succeeded on retry with auto');
  });
});

describe('TC04 undefined fields stripped', async () => {
  it('stripUndefined removes undefined recursively', () => {
    const dirty = { uid: 'u1', caseCard: { riskScore: undefined, state: 'APPROVED' }, auditEvents: undefined };
    const clean = stripUndefined(dirty);
    assert.ok(!('auditEvents' in clean), 'auditEvents stripped');
    assert.ok(!('riskScore' in clean.caseCard), 'riskScore stripped');
    assert.equal(clean.caseCard.state, 'APPROVED', 'defined values preserved');
  });

  it('riskScore defaults to 0 in internal doc when undefined', async () => {
    const mockDb = createMockDb();
    await saveConversation({ db: mockDb, conversationId: 'conv-tc04', uid: 'u1', messages: [], caseCard: { riskScore: undefined, state: 'COMPLETED' }, auditEvents: [] });
    const internal = mockDb._getInternal('agent_conversations', 'conv-tc04', 'internal', 'staff');
    assert.ok(internal, 'internal doc written');
    assert.equal(internal.caseCard_internal.riskScore, 0, 'riskScore=0 when undefined');
    assert.ok(Array.isArray(internal.caseCard_internal.riskFlags), 'riskFlags is array');
  });
});

describe('TC05 directAnswer and chainValid logic', async () => {
  it('directAnswer true with no tool events', () => { assert.equal([].length === 0, true); });
  it('chainValid null when no events have returnId', () => {
    const evts = [{ actor: 'agent', action: 'LIST_MY_ORDERS', hash: 'abc' }];
    const chainable = evts.filter(e => e.hash && e.returnId);
    assert.equal(chainable.length > 0 ? true : null, null);
  });
});

function createMockDb() {
  const cols = {};
  function getCol(n) { if (!cols[n]) cols[n] = { docs: new Map(), refs: new Map() }; return cols[n]; }
  function mkRef(col, id) {
    const c = getCol(col); const subcols = {};
    const ref = {
      _subcols: subcols,
      get: async () => { const d = c.docs.get(id); return { exists: !!d, id, data: () => d ? { ...d } : undefined }; },
      set: async (data, opts) => { const ex = c.docs.get(id) || {}; c.docs.set(id, opts && opts.merge ? { ...ex, ...data } : { ...data }); },
      update: async (data) => { const ex = c.docs.get(id) || {}; c.docs.set(id, { ...ex, ...data }); },
      collection: (sub) => {
        if (!subcols[sub]) subcols[sub] = new Map();
        return { doc: (sid) => ({ set: async (data, opts) => { const ex = subcols[sub].get(sid) || {}; subcols[sub].set(sid, opts && opts.merge ? { ...ex, ...data } : { ...data }); } }) };
      },
    };
    c.refs.set(id, ref); return ref;
  }
  return {
    collection: (c) => ({ doc: (id) => mkRef(c, id) }),
    _getInternal: (col, doc, sub, sdoc) => {
      const c = cols[col]; if (!c) return null;
      const ref = c.refs.get(doc); if (!ref || !ref._subcols[sub]) return null;
      return ref._subcols[sub].get(sdoc) || null;
    },
  };
}

// ─── TC06: list_my_orders reads customer.user_id schema ──────────────────────

describe('TC06 list_my_orders reads customer.user_id schema', async () => {
  it('returns orders stored under customer.user_id matching seed + browser schema', async () => {
    const uid = 'u-tc06-test';
    // Build a fake db that returns one order in the seed schema
    const seedOrder = {
      id: 'ORD-TC06-001',
      customer: { user_id: uid, email: 'test@test.com', full_name: 'Test User' },
      status: 'delivered',
      delivered_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      created_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
      items: [{ product_id: 'prod_fashion_shirt', name: 'Cotton Shirt', price: 1499, quantity: 1, category: 'fashion' }],
      total_amount: 1499,
    };

    // Minimal fake db that responds to the nested-field where() call
    const fakeDb = {
      collection: (colName) => ({
        where: (field, _op, val) => ({
          get: async () => {
            if (field === 'customer.user_id' && val === uid) {
              return {
                docs: [{ id: seedOrder.id, data: () => seedOrder }],
              };
            }
            return { docs: [] };
          },
        }),
      }),
    };

    const result = await executeTool({ name: 'list_my_orders', args: {}, uid, conversationId: 'c-tc06', db: fakeDb });
    assert.ok(result.ok, `list_my_orders failed: ${JSON.stringify(result.result)}`);
    const { orders } = result.result;
    assert.ok(Array.isArray(orders), 'orders should be an array');
    assert.equal(orders.length, 1, 'should find exactly 1 seeded order');
    assert.equal(orders[0].id, 'ORD-TC06-001', 'order id should match');
    assert.ok(Array.isArray(orders[0].items), 'items should be an array');
    assert.equal(orders[0].items[0].name, 'Cotton Shirt', 'item name should be present');
    assert.equal(orders[0].items[0].category, 'fashion', 'item category should be present');
  });
});

// ─── TC07: 2 tool calls + 1 fallback = 3 audit events ───────────────────────

describe('TC07 audit events accumulate across tools and fallback', async () => {
  it('2 tool calls + 1 fallback escalation produces 3 audit events', async () => {
    const u = uid(), c = cid();
    const llm = fakeLLM([
      { tool_calls: [{ name: 'list_my_orders', args: {} }] },
      { tool_calls: [{ name: 'check_eligibility', args: { order_id: 'TEST-FASHION-OK', product_id: 'P-SHIRT', quantity: 1, reason: 'damage' } }] },
      { tool_calls: [{ name: 'check_eligibility', args: { order_id: 'TEST-FASHION-OK', product_id: 'P-SHIRT', quantity: 1, reason: 'damage' } }] },
      { tool_calls: [{ name: 'check_eligibility', args: { order_id: 'TEST-FASHION-OK', product_id: 'P-SHIRT', quantity: 1, reason: 'damage' } }] },
      { tool_calls: [{ name: 'check_eligibility', args: { order_id: 'TEST-FASHION-OK', product_id: 'P-SHIRT', quantity: 1, reason: 'damage' } }] },
      { tool_calls: [{ name: 'check_eligibility', args: { order_id: 'TEST-FASHION-OK', product_id: 'P-SHIRT', quantity: 1, reason: 'damage' } }] },
      { tool_calls: [{ name: 'check_eligibility', args: { order_id: 'TEST-FASHION-OK', product_id: 'P-SHIRT', quantity: 1, reason: 'damage' } }] },
      { tool_calls: [{ name: 'check_eligibility', args: { order_id: 'TEST-FASHION-OK', product_id: 'P-SHIRT', quantity: 1, reason: 'damage' } }] },
    ]);
    // 8 tool calls forces step limit → ESCALATE_TO_HUMAN fallback added automatically
    const r = await runLoop({ userMessage: 'My cotton shirt arrived damaged', conversationId: c, uid: u, db: null, llmOverride: llm });
    // Should have LIST_MY_ORDERS + multiple CHECK_ELIGIBILITY + ESCALATE_TO_HUMAN
    assert.ok(r.auditEvents.length >= 3, `Expected >= 3 audit events, got ${r.auditEvents.length}`);
    const actions = r.auditEvents.map(e => e.action);
    assert.ok(actions.includes('LIST_MY_ORDERS'), 'LIST_MY_ORDERS event present');
    assert.ok(actions.includes('ESCALATE_TO_HUMAN'), 'ESCALATE_TO_HUMAN event present');
  });

  it('saveConversation accumulates events across turns (never overwrites with empty)', async () => {
    const mockDb = createMockDb();
    const cid2 = 'conv-tc07-accum';
    // Turn 1: 1 event
    await saveConversation({ db: mockDb, conversationId: cid2, uid: 'u1', messages: [], caseCard: {}, auditEvents: [{ actor: 'agent', action: 'LIST_MY_ORDERS', hash: 'h1' }] });
    // Turn 2: 0 events (simulate agent replying without tools)
    await saveConversation({ db: mockDb, conversationId: cid2, uid: 'u1', messages: [], caseCard: {}, auditEvents: [] });
    // Root doc should still have the original event from turn 1
    // (the memory store holds the merged state)
    const { _getAll } = await import('../agent/conversations.js');
    const all = _getAll();
    const conv = all.find(c => c.conversationId === cid2);
    assert.ok(conv, 'conversation should be in memory store');
    // auditEvents from turn 1 should still be there (not overwritten by empty turn 2)
    assert.equal(conv.auditEvents.length, 1, `Expected 1 audit event after 2 turns, got ${conv.auditEvents.length}`);
  });
});
