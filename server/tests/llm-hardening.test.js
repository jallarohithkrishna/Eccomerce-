/**
 * LLM Config, Hardening & Grounding Tests — PS-01 Phase C3
 *
 * Tests:
 * 1. Timeout handling (AbortController)
 * 2. Safe error sanitization (API key redacted)
 * 3. 429 rate limit retry with backoff
 * 4. 5xx server error retry with backoff
 * 5. Fallback model execution on primary model failure
 * 6. Daily request cap (AGENT_DAILY_CAP)
 * 7. Scripted fallback on LLM failure calling escalate_to_human
 * 8. Grounding check replacing hallucinated numbers, dates, RMAs, amounts
 *
 * Run: node --test tests/llm-hardening.test.js
 */

import { strict as assert } from 'assert';
import { describe, it, before, beforeEach, afterEach } from 'node:test';

import { callLLM, LLMError } from '../llm/client.js';
import { runLoop, groundingCheck } from '../agent/loop.js';
import * as session from '../agent/session.js';
import * as returnStore from '../returns/store.js';

const originalEnv = { ...process.env };

before(() => {
  process.env.NODE_ENV = 'test';
});

beforeEach(() => {
  session._clearAll();
  returnStore._clearAll();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('LLM Client — Hardening & Resilience', () => {
  it('LLM01: throws timeout error when request exceeds timeoutMs', async () => {
    process.env.LLM_API_KEY = 'test-key';
    const fakeSlowFetch = async (url, opts) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'slow' } }] }),
          });
        }, 200);
        opts.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    await assert.rejects(
      () => callLLM({
        messages: [{ role: 'user', content: 'hello' }],
        timeoutMs: 50,
        fetchImpl: fakeSlowFetch,
      }),
      (err) => {
        assert.equal(err.code, 'TIMEOUT');
        assert.ok(err.message.includes('timed out'));
        return true;
      }
    );
  });

  it('LLM02: sanitizes API key from error messages and logs', () => {
    const sensitive = new LLMError('Failed with Authorization: Bearer sk-secret-123456789 and key=secret-abc', 'API_ERROR', 401);
    assert.strictEqual(sensitive.message.includes('sk-secret-123456789'), false);
    assert.strictEqual(sensitive.message.includes('secret-abc'), false);
    assert.ok(sensitive.message.includes('[REDACTED]'));
  });

  it('LLM03: retries on 429 status and succeeds on subsequent attempt', async () => {
    process.env.LLM_API_KEY = 'test-key';
    let attempts = 0;
    const fakeRateLimitedFetch = async () => {
      attempts++;
      if (attempts === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => 'Rate limit exceeded',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Rate limit recovered' }, finish_reason: 'stop' }],
        }),
      };
    };

    const res = await callLLM({
      messages: [{ role: 'user', content: 'test' }],
      fetchImpl: fakeRateLimitedFetch,
      maxRetries: 2,
    });

    assert.equal(attempts, 2, 'should have retried once');
    assert.equal(res.message.content, 'Rate limit recovered');
  });

  it('LLM04: retries on 503 error and succeeds on subsequent attempt', async () => {
    process.env.LLM_API_KEY = 'test-key';
    let attempts = 0;
    const fakeServerErrFetch = async () => {
      attempts++;
      if (attempts === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => 'Service Unavailable',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Server recovered' }, finish_reason: 'stop' }],
        }),
      };
    };

    const res = await callLLM({
      messages: [{ role: 'user', content: 'test' }],
      fetchImpl: fakeServerErrFetch,
      maxRetries: 2,
    });

    assert.equal(attempts, 2);
    assert.equal(res.message.content, 'Server recovered');
  });

  it('LLM05: switches to LLM_FALLBACK_MODEL on primary model exhaustion', async () => {
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_MODEL = 'primary-model-fail';
    process.env.LLM_FALLBACK_MODEL = 'fallback-model-pass';

    const modelsCalled = [];
    const fakeFallbackFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      modelsCalled.push(body.model);
      if (body.model === 'primary-model-fail') {
        return {
          ok: false,
          status: 500,
          text: async () => 'Primary model crash',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Response from fallback' }, finish_reason: 'stop' }],
        }),
      };
    };

    const res = await callLLM({
      messages: [{ role: 'user', content: 'test' }],
      fetchImpl: fakeFallbackFetch,
      maxRetries: 1,
    });

    assert.ok(modelsCalled.includes('primary-model-fail'), 'must have attempted primary');
    assert.ok(modelsCalled.includes('fallback-model-pass'), 'must have switched to fallback');
    assert.equal(res.message.content, 'Response from fallback');
    assert.equal(res.modelUsed, 'fallback-model-pass');
  });
});

describe('Agent — Daily Request Cap & Scripted Fallback', () => {
  it('LLM06: enforces per-user daily request cap (AGENT_DAILY_CAP)', async () => {
    process.env.AGENT_DAILY_CAP = '3';
    const uid = 'cust_cap_test';
    const fakeLLM = async () => ({ message: { content: 'OK' }, finish_reason: 'stop' });

    // Request 1, 2, 3 -> Allowed
    const r1 = await runLoop({ userMessage: 'return help 1', conversationId: 'conv_cap_1', uid, llmOverride: fakeLLM });
    assert.ok(!r1.dailyCapExceeded);

    const r2 = await runLoop({ userMessage: 'return help 2', conversationId: 'conv_cap_2', uid, llmOverride: fakeLLM });
    assert.ok(!r2.dailyCapExceeded);

    const r3 = await runLoop({ userMessage: 'return help 3', conversationId: 'conv_cap_3', uid, llmOverride: fakeLLM });
    assert.ok(!r3.dailyCapExceeded);

    // Request 4 -> Exceeded
    const r4 = await runLoop({ userMessage: 'return help 4', conversationId: 'conv_cap_4', uid, llmOverride: fakeLLM });
    assert.equal(r4.dailyCapExceeded, true);
    assert.ok(r4.reply.includes('daily message limit'));
    assert.ok(r4.auditEvents.some(e => e.action === 'DAILY_CAP_EXCEEDED'));
  });

  it('LLM07: scripted fallback triggers on LLM error and escalates to human with transcript', async () => {
    const failingLLM = async () => {
      throw new Error('LLM connection terminated unexpectedly');
    };

    const res = await runLoop({
      userMessage: 'I need to return order ord_fail_1',
      conversationId: 'conv_fail_llm',
      uid: 'cust_fail_1',
      llmOverride: failingLLM,
    });

    assert.ok(res.reply.includes('passed your request to our team'));
    assert.ok(res.auditEvents.some(e => e.action === 'ESCALATE_TO_HUMAN'));
  });
});

describe('Agent — Grounding Verification', () => {
  it('LLM08: replaces hallucinated refund amounts with safe template built from tool results', () => {
    const toolResults = [{
      return_id: 'ret_ground_1',
      rma_number: 'RMA-REAL123',
      status: 'APPROVED',
      refund_amount: 1500,
    }];

    // Hallucinated amount: ₹99999 is not in tool results (which had 1500)
    const hallucinatedReply = 'I have approved your return. You will receive ₹99999 in your account!';
    const grounded = groundingCheck(hallucinatedReply, toolResults);

    assert.strictEqual(grounded.includes('99999'), false, 'hallucinated amount must be purged');
    assert.ok(grounded.includes('RMA-REAL123'), 'template must contain verified RMA');
    assert.ok(grounded.includes('1500'), 'template must contain verified amount');
  });

  it('LLM09: replaces hallucinated dates with safe template built from tool results', () => {
    const toolResults = [{
      return_id: 'ret_ground_2',
      rma_number: 'RMA-REAL456',
      status: 'APPROVED',
      pickup_date: '2026-10-10',
    }];

    // Hallucinated date: 2029-12-31 is not in tool results
    const hallucinatedReply = 'Your courier pickup is scheduled for 2029-12-31!';
    const grounded = groundingCheck(hallucinatedReply, toolResults);

    assert.strictEqual(grounded.includes('2029-12-31'), false, 'hallucinated date must be purged');
    assert.ok(grounded.includes('RMA-REAL456'));
  });

  it('LLM10: replaces hallucinated RMA codes with verified RMA from tool results', () => {
    const toolResults = [{
      return_id: 'ret_ground_3',
      rma_number: 'RMA-AUTHENTIC99',
      status: 'APPROVED',
    }];

    // Hallucinated RMA: RMA-FAKEXYZ is not in tool results
    const hallucinatedReply = 'Your return RMA code is RMA-FAKEXYZ.';
    const grounded = groundingCheck(hallucinatedReply, toolResults);

    assert.strictEqual(grounded.includes('RMA-FAKEXYZ'), false, 'hallucinated RMA must be purged');
    assert.ok(grounded.includes('RMA-AUTHENTIC99'));
  });

  it('LLM11: allows grounded numbers, dates, and RMAs to pass untouched', () => {
    const toolResults = [{
      return_id: 'ret_ground_4',
      rma_number: 'RMA-ACCURATE1',
      status: 'APPROVED',
      refund_amount: 500,
    }];

    const verifiedReply = 'Your return ret_ground_4 with RMA-ACCURATE1 has been approved for ₹500.';
    const grounded = groundingCheck(verifiedReply, toolResults);
    assert.equal(grounded, verifiedReply, 'verified reply should remain intact');
  });
});
