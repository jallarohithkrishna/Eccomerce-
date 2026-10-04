/**
 * Provider-agnostic LLM Client — PS-01
 * OpenAI-compatible function calling via HTTP.
 * Supports: OpenAI, Groq, Together, or any OpenAI-compat endpoint.
 * Set LLM_BASE_URL + LLM_API_KEY + LLM_MODEL in server/.env
 */

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_API_KEY  = process.env.LLM_API_KEY  || process.env.OPENAI_API_KEY || '';
const LLM_MODEL    = process.env.LLM_MODEL    || 'gpt-4o-mini';
const LLM_TIMEOUT  = parseInt(process.env.LLM_TIMEOUT_MS || '18000', 10);

export const PROMPT_VERSION = 'v1.0';

/**
 * Call the LLM with messages and optional tool definitions.
 * Returns the raw choice object { message, finish_reason }.
 *
 * @param {Object} params
 * @param {Array}  params.messages   - OpenAI chat messages array
 * @param {Array}  [params.tools]    - OpenAI function tool definitions
 * @param {string} [params.model]    - Override model
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @returns {Promise<{message: Object, finish_reason: string, usage: Object}>}
 */
export async function callLLM({ messages, tools = [], model, maxTokens = 512, temperature = 0 }) {
  if (!LLM_API_KEY) throw new LLMError('LLM_API_KEY is not configured', 'CONFIG_ERROR');

  const body = {
    model:       model || LLM_MODEL,
    messages,
    temperature,
    max_tokens:  maxTokens,
  };

  if (tools.length > 0) {
    body.tools      = tools;
    body.tool_choice = 'auto';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT);

  let response;
  try {
    response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
      },
      body:   JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new LLMError('LLM request timed out', 'TIMEOUT');
    throw new LLMError(`Network error: ${err.message}`, 'NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LLMError(`LLM API error ${response.status}: ${text}`, 'API_ERROR', response.status);
  }

  const json = await response.json();
  const choice = json.choices?.[0];
  if (!choice) throw new LLMError('Empty response from LLM', 'EMPTY_RESPONSE');

  return {
    message:       choice.message,
    finish_reason: choice.finish_reason,
    usage:         json.usage || {},
  };
}

/**
 * Classify whether a user message is in scope (returns/refunds/exchanges/order-status).
 * Returns { inScope: boolean, confidence: 'high'|'low' }
 * Uses a cheap single-message call with a binary system prompt.
 */
export async function classifyScope(userMessage) {
  const keywords = [
    'return', 'refund', 'exchange', 'replace', 'replacement', 'damaged', 'defect',
    'defective', 'broken', 'wrong item', 'not delivered', 'missing', 'spoiled',
    'pickup', 'rma', 'appeal', 'escalate', 'order status', 'return status',
    'where is my return', 'money back', 'store credit',
    // additional in-scope signals
    'my order', 'my orders', 'recent order', 'order list', 'order id',
    'speak to', 'human agent', 'specialist', 'human help', 'real person',
    'arrived', 'leaking', 'leaked', 'cracked', 'dented', 'not working',
    'help with a return', 'help with return', 'i need help', 'can you help',
    'moisturizer', 'lotion', 'cream', 'cosmetic', 'product issue',
  ];
  const lower = userMessage.toLowerCase();
  const keywordHit = keywords.some(k => lower.includes(k));

  // Fast-path: clear keyword hit → in scope without LLM call
  if (keywordHit) return { inScope: true, confidence: 'high' };

  // Clear off-topic patterns — only fire on obviously unrelated content
  // Pattern must NOT match sentences that could be about returns/orders
  const offTopicPatterns = [
    /^(what is the weather|what'?s the weather)/i,
    /\b(stock price|recipe|joke|poem|song|movie recommendation|sport score|news headline|politics|covid vaccine|flight price)\b/i,
    /^(what is|who is|capital of|define) /i,
    /^(write me a |can you write|generate a (python|java|code|script))/i,
  ];
  if (offTopicPatterns.some(p => p.test(userMessage.trim()))) {
    return { inScope: false, confidence: 'high' };
  }

  // Ambiguous — ask LLM for a single-word answer
  if (!LLM_API_KEY) return { inScope: false, confidence: 'low' };

  try {
    const { message } = await callLLM({
      messages: [
        {
          role: 'system',
          content: 'You are a classifier. Reply only with "YES" or "NO". Is the user message about a product return, refund, exchange, or order delivery/status?',
        },
        { role: 'user', content: userMessage.slice(0, 300) },
      ],
      maxTokens: 5,
      temperature: 0,
    });
    const ans = (message.content || '').trim().toUpperCase();
    return { inScope: ans === 'YES', confidence: 'low' };
  } catch {
    // If LLM fails the scope check, allow through (fail open so genuine returns aren't blocked)
    return { inScope: true, confidence: 'low' };
  }
}

export class LLMError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = status;
  }
}
