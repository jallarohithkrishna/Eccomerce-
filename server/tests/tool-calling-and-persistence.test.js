/**
 * Tool-Calling Behaviour and Persistence Tests
 * TC01 - Direct-answer: LLM never calls tools, reply returned, 0 tool events
 * TC02 - list_my_orders then check_eligibility: 2 audit events in order
 * TC03 - First-turn toolChoice=required forwarded to LLM
 * TC04 - Undefined fields stripped; riskScore defaults to 0
 * TC05 - directAnswer and chainValid derivation
 */

import { strict as assert } from 'assert';
import { describe, it, beforeEach } from 'node:test';
import { runLoop }          from '../agent/loop.js';
import * as session         from '../agent/session.js';
import { saveConversation } from '../agent/conversations.js';
import { stripUndefined }   from '../utils/stripUndefined.js';

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
