/**
 * Vision / Evidence Analysis — PS-01 Phase B
 *
 * Receives an image buffer, runs a vision LLM call describing:
 *   - Product category and visible item
 *   - Damage or defect observed (or "none apparent")
 *   - Confidence level (high / medium / low)
 *
 * Returns a structured analysis. If the vision call fails, returns
 * { verified: false, analysis: 'Vision analysis unavailable' } — never blocks the flow.
 *
 * SAFETY: The image description is returned as untrusted data to the agent.
 * The agent context wraps it in a delimited block labelled as DATA.
 *
 * Storage: Only the SHA-256 hash and analysis text are stored — never the raw image.
 */

import { createHash } from 'crypto';

/**
 * Accepted image MIME types (checked by magic bytes, not extension).
 */
export const ACCEPTED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

/**
 * Detect MIME type from buffer magic bytes (no extension trust).
 * @param {Buffer} buf
 * @returns {string|null}
 */
export function detectMimeType(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'image/webp';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  return null;
}

/**
 * Compute SHA-256 hash of a buffer.
 */
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Run vision analysis on an image buffer.
 *
 * @param {Object} params
 * @param {Buffer} params.imageBuffer
 * @param {string} params.mimeType         - verified MIME type
 * @param {Function} [params.visionOverride] - fake for tests
 * @returns {Promise<{verified: boolean, hash: string, mimeType: string, analysis: string, confidence: string}>}
 */
export async function analyzeEvidence({ imageBuffer, mimeType, visionOverride = null }) {
  const hash = sha256(imageBuffer);
  const b64  = imageBuffer.toString('base64');

  const callVision = visionOverride || _realVisionCall;

  try {
    const analysis = await callVision({ b64, mimeType });
    return {
      verified:  true,
      hash,
      mimeType,
      sizeBytes: imageBuffer.length,
      analysis,
      confidence: _extractConfidence(analysis),
    };
  } catch (err) {
    console.warn('Vision analysis failed (non-blocking):', err.message);
    return {
      verified:  false,
      hash,
      mimeType,
      sizeBytes: imageBuffer.length,
      analysis:  'Vision analysis unavailable — evidence recorded as unverified.',
      confidence: 'low',
    };
  }
}

// ─── Real vision call (OpenAI-compatible vision) ──────────────────────────

async function _realVisionCall({ b64, mimeType }) {
  const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const LLM_API_KEY  = process.env.LLM_API_KEY  || process.env.OPENAI_API_KEY || '';
  const LLM_MODEL    = process.env.VISION_MODEL  || process.env.LLM_MODEL || 'gpt-4o-mini';

  if (!LLM_API_KEY) throw new Error('LLM_API_KEY not configured for vision');

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are a return evidence analyst. Describe this image in 2-3 sentences covering:
1. What product or item is visible
2. Any damage, defects, or issues visible (be specific — cracks, stains, missing parts, etc.)
3. Your confidence that this image supports a damage/defect return claim: high / medium / low

Be factual. Do not add opinions. End with "Confidence: [level]".`
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${b64}`, detail: 'low' },
          },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    throw new Error(`Vision API error ${response.status}: ${txt.slice(0, 200)}`);
  }
  const json = await response.json();
  return json.choices?.[0]?.message?.content || 'No description returned.';
}

function _extractConfidence(text = '') {
  const lower = text.toLowerCase();
  if (lower.includes('confidence: high')) return 'high';
  if (lower.includes('confidence: medium')) return 'medium';
  return 'low';
}

/**
 * In-memory evidence store: evidenceId → record (no raw image stored).
 * @type {Map<string, {hash, mimeType, sizeBytes, analysis, confidence, verified, caseId, timestamp}>}
 */
export const evidenceStore = new Map();

/** Store evidence analysis result (not the image). */
export function storeEvidence({ conversationId, hash, mimeType, sizeBytes, analysis, confidence, verified }) {
  const evidenceId = `ev_${Date.now().toString(36)}`;
  const record = {
    evidenceId, conversationId, hash, mimeType, sizeBytes,
    analysis, confidence, verified,
    timestamp: new Date().toISOString(),
  };
  evidenceStore.set(evidenceId, record);
  return record;
}

/** Rate limit: max 5 uploads per hour per conversationId */
const uploadCounts = new Map(); // conversationId → {count, windowStart}
export function checkUploadRateLimit(conversationId) {
  const now  = Date.now();
  const hour = 60 * 60 * 1000;
  const entry = uploadCounts.get(conversationId) || { count: 0, windowStart: now };
  if (now - entry.windowStart > hour) {
    entry.count = 0; entry.windowStart = now;
  }
  entry.count++;
  uploadCounts.set(conversationId, entry);
  return entry.count <= 5;
}

/** For tests */
export function _clearEvidence() { evidenceStore.clear(); uploadCounts.clear(); }
