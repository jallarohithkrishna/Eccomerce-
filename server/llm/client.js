/**
 * Provider-agnostic LLM Client — PS-01 Hardened
 * OpenAI-compatible function calling via HTTP.
 * Supports: OpenAI, Groq, Together, or any OpenAI-compat endpoint.
 * Configured exclusively via environment variables:
 *   LLM_BASE_URL, LLM_MODEL, LLM_FALLBACK_MODEL, LLM_API_KEY, LLM_TIMEOUT_MS
 *
 * Hardening features:
 * - Dynamic env resolution (no hardcoded keys)
 * - Safe error handling: API keys are never exposed in error messages or logs
 * - AbortController timeout (default 18s)
 * - Automatic retry with exponential backoff on HTTP 429 and 5xx errors
 * - Automatic fallback model switching on primary model exhaustion
 */

export const PROMPT_VERSION = 'v1.0';

/**
 * Custom error class for LLM failures that strips any sensitive API keys.
 */
export class LLMError extends Error {
  constructor(message, code, status) {
    const sanitized = String(message || '')
      .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
      .replace(/key=[A-Za-z0-9_\-\.]+/gi, 'key=[REDACTED]');
    super(sanitized);
    this.name = 'LLMError';
    this.code = code || 'LLM_ERROR';
    this.status = status;
  }
}

/**
 * Execute a single HTTP call to the completions endpoint.
 */
async function _singleChatCall({ baseUrl, apiKey, model, messages, tools, maxTokens, temperature, timeoutMs, fetchImpl }) {
  const customFetch = fetchImpl || fetch;
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await customFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new LLMError(`LLM request timed out after ${timeoutMs}ms`, 'TIMEOUT');
    }
    throw new LLMError(`Network error: ${err.message}`, 'NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LLMError(`LLM API error (${model}) ${response.status}: ${text}`, 'API_ERROR', response.status);
  }

  const json = await response.json();
  const choice = json.choices?.[0];
  if (!choice) throw new LLMError(`Empty response from LLM model ${model}`, 'EMPTY_RESPONSE');

  return {
    message: choice.message,
    finish_reason: choice.finish_reason,
    usage: json.usage || {},
    modelUsed: model,
  };
}

/**
 * Call the LLM with retry, backoff, and fallback model support.
 *
 * @param {Object} params
 * @param {Array}  params.messages
 * @param {Array}  [params.tools]
 * @param {string} [params.model]
 * @param {string} [params.fallbackModel]
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.maxRetries] - retries per model on 429/5xx (default 2)
 * @param {Function} [params.fetchImpl] - custom fetch implementation for testing
 * @returns {Promise<{message: Object, finish_reason: string, usage: Object, modelUsed: string}>}
 */
export async function callLLM({
  messages,
  tools = [],
  model,
  fallbackModel,
  maxTokens = 512,
  temperature = 0,
  timeoutMs,
  maxRetries = 2,
  fetchImpl,
} = {}) {
  const baseUrl       = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const apiKey        = process.env.LLM_API_KEY  || process.env.OPENAI_API_KEY || '';
  const primaryModel  = model || process.env.LLM_MODEL || 'gpt-4o-mini';
  const fallback      = fallbackModel || process.env.LLM_FALLBACK_MODEL || '';
  const effectiveTimeout = timeoutMs || parseInt(process.env.LLM_TIMEOUT_MS || '18000', 10);

  if (!apiKey) {
    throw new LLMError('LLM_API_KEY is not configured', 'CONFIG_ERROR');
  }

  const modelsToTry = [primaryModel];
  if (fallback && fallback !== primaryModel) {
    modelsToTry.push(fallback);
  }

  let lastError = null;

  for (const currentModel of modelsToTry) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await _singleChatCall({
          baseUrl,
          apiKey,
          model: currentModel,
          messages,
          tools,
          maxTokens,
          temperature,
          timeoutMs: effectiveTimeout,
          fetchImpl,
        });
        return result;
      } catch (err) {
        lastError = err;

        // Check if retryable (429 rate-limited or 5xx server errors)
        const isRetryableStatus = err.status === 429 || (err.status >= 500 && err.status <= 599);
        const isTimeout = err.code === 'TIMEOUT' || err.code === 'NETWORK_ERROR';
        const canRetry = (isRetryableStatus || isTimeout) && attempt < maxRetries;

        if (canRetry) {
          const backoffDelay = Math.min(50 * Math.pow(2, attempt), 1000);
          await new Promise(r => setTimeout(r, backoffDelay));
          continue;
        }

        // Break inner retry loop to try next fallback model
        break;
      }
    }
  }

  throw lastError || new LLMError('Failed to obtain response from LLM', 'CALL_FAILED');
}

/**
 * Classify whether a user message is in scope.
 */
export async function classifyScope(userMessage, { llmOverride } = {}) {
  const keywords = [
    'return', 'refund', 'exchange', 'replace', 'replacement', 'damaged', 'defect',
    'defective', 'broken', 'wrong item', 'not delivered', 'missing', 'spoiled',
    'pickup', 'rma', 'appeal', 'escalate', 'order status', 'return status',
    'where is my return', 'money back', 'store credit',
    'my order', 'my orders', 'recent order', 'order list', 'order id',
    'speak to', 'human agent', 'specialist', 'human help', 'real person',
    'arrived', 'leaking', 'leaked', 'cracked', 'dented', 'not working',
    'help with a return', 'help with return', 'i need help', 'can you help',
    'moisturizer', 'lotion', 'cream', 'cosmetic', 'product issue',
    'वापस', 'वापसी', 'पैसे वापस', 'खराब', 'टूट', 'सामान', 'ऑर्डर',
    'రిటర్న్', 'వాపస్', 'డబ్బులు', 'పాడైపోయింది', 'ఆర్డర్',
  ];
  const lower = String(userMessage || '').toLowerCase();
  const keywordHit = keywords.some(k => lower.includes(k));

  if (keywordHit) return { inScope: true, confidence: 'high' };

  const offTopicPatterns = [
    /^(what is the weather|what'?s the weather)/i,
    /\b(stock price|recipe|joke|poem|song|movie recommendation|sport score|news headline|politics|covid vaccine|flight price)\b/i,
    /^(what is|who is|capital of|define) /i,
    /^(write me a |can you write|generate a (python|java|code|script))/i,
  ];
  if (offTopicPatterns.some(p => p.test(userMessage.trim()))) {
    return { inScope: false, confidence: 'high' };
  }

  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!apiKey && !llmOverride) return { inScope: true, confidence: 'low' };

  const llmCall = llmOverride || callLLM;

  try {
    const { message } = await llmCall({
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
    return { inScope: true, confidence: 'low' };
  }
}

let fallbackWarned = false;

/**
 * Validates LLM configuration and logs warnings on startup.
 * Specifically checks if LLM_FALLBACK_MODEL is unset and logs a warning.
 *
 * @param {Object} [options]
 * @param {Function} [options.warn] - Custom warning logger (defaults to console.warn)
 * @param {boolean} [options.force] - Force logging even if already logged
 * @returns {boolean} Whether LLM_FALLBACK_MODEL is configured
 */
export function checkLLMConfig({ warn = console.warn, force = false } = {}) {
  const fallback = process.env.LLM_FALLBACK_MODEL;
  if (!fallback) {
    if (!fallbackWarned || force) {
      fallbackWarned = true;
      warn('[LLM STARTUP WARNING] LLM_FALLBACK_MODEL is unset. No fallback model configured; only scripted fallback will be used on primary model failure. To configure, supply a full provider ID (e.g. vendor/model like openai/gpt-3.5-turbo or groq/llama-3.1-8b-instant).');
    }
    return false;
  }
  return true;
}

export function resetFallbackWarned() {
  fallbackWarned = false;
}
