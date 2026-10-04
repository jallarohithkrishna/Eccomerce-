/**
 * Exception Matrix — PS-01
 * Maps structured exception conditions to the correct action.
 * Returns { action: 'HUMAN_REVIEW'|'REJECT'|'APPROVE', reason, code }
 * No LLM. No side-effects.
 */

export const ExceptionAction = Object.freeze({
  HUMAN_REVIEW: 'HUMAN_REVIEW',
  REJECT:       'REJECT',
  APPROVE:      'APPROVE',
});

/**
 * @typedef {Object} ExceptionContext
 * @property {boolean} [fraudFlag]           - Flagged by fraud detection
 * @property {number}  [priorReturnsCount]   - # of returns by this user in last 30d
 * @property {boolean} [addressMismatch]     - Shipping / registered address mismatch
 * @property {boolean} [photoEvidence]       - Photo evidence uploaded
 * @property {boolean} [highValue]           - Item value above policy threshold
 * @property {string}  [decisionCode]        - From policy engine
 * @property {boolean} [refundGatewayFailed] - Refund already failed once
 * @property {number}  [refundRetryCount]    - Number of retry attempts
 * @property {boolean} [warehouseRejection]  - Warehouse inspection failed
 * @property {boolean} [promptInjection]     - LLM flagged injection attempt
 * @property {string}  [policyKey]           - Canonical policy category
 */

/**
 * Evaluate exception conditions and return the appropriate action.
 * Conditions are evaluated in priority order (highest risk first).
 *
 * @param {ExceptionContext} ctx
 * @returns {{ action: string, code: string, reason: string }}
 */
export function evaluateException(ctx) {
  const {
    fraudFlag          = false,
    priorReturnsCount  = 0,
    addressMismatch    = false,
    photoEvidence      = false,
    highValue          = false,
    decisionCode       = '',
    refundGatewayFailed = false,
    refundRetryCount   = 0,
    warehouseRejection = false,
    promptInjection    = false,
    policyKey          = 'standard',
  } = ctx;

  // ── Priority 1: Prompt injection (always log + ignore; never trust LLM data) ──
  if (promptInjection) {
    return {
      action: ExceptionAction.HUMAN_REVIEW,
      code:   'PROMPT_INJECTION_DETECTED',
      reason: 'Potential prompt injection detected in customer message. Case escalated to human review.',
    };
  }

  // ── Priority 2: Fraud signal ─────────────────────────────────────────────
  if (fraudFlag) {
    return {
      action: ExceptionAction.HUMAN_REVIEW,
      code:   'FRAUD_FLAG',
      reason: 'Fraud signal detected. Return requires specialist review.',
    };
  }

  // ── Priority 3: Address mismatch ──────────────────────────────────────────
  if (addressMismatch) {
    return {
      action: ExceptionAction.HUMAN_REVIEW,
      code:   'ADDRESS_MISMATCH',
      reason: 'Shipping address does not match registered account address. Requires manual verification.',
    };
  }

  // ── Priority 4: Warehouse inspection failure ──────────────────────────────
  if (warehouseRejection) {
    return {
      action: ExceptionAction.REJECT,
      code:   'WAREHOUSE_INSPECTION_FAILED',
      reason: 'Item failed warehouse inspection (condition, tags, or serial mismatch). Return rejected.',
    };
  }

  // ── Priority 5: High-value item ───────────────────────────────────────────
  if (highValue || decisionCode === 'HIGH_VALUE_HUMAN_REVIEW') {
    return {
      action: ExceptionAction.HUMAN_REVIEW,
      code:   'HIGH_VALUE_REVIEW',
      reason: 'Item value exceeds automatic approval threshold. Specialist review required.',
    };
  }

  // ── Priority 6: Excessive returns pattern ────────────────────────────────
  if (priorReturnsCount >= 5) {
    return {
      action: ExceptionAction.HUMAN_REVIEW,
      code:   'EXCESSIVE_RETURNS',
      reason: `Customer has ${priorReturnsCount} return(s) in the last 30 days. Pattern review required.`,
    };
  }

  // ── Priority 7: Refund gateway persistent failure ────────────────────────
  if (refundGatewayFailed && refundRetryCount >= 3) {
    return {
      action: ExceptionAction.HUMAN_REVIEW,
      code:   'REFUND_GATEWAY_PERSISTENT_FAILURE',
      reason: `Refund gateway has failed ${refundRetryCount} times. Manual intervention required.`,
    };
  }

  // ── Priority 8: Missing photo for category requiring it ──────────────────
  if (!photoEvidence && ['groceries', 'beauty', 'electronics'].includes(policyKey)) {
    return {
      action: ExceptionAction.HUMAN_REVIEW,
      code:   'PHOTO_EVIDENCE_MISSING',
      reason: 'Photo evidence is required for this category but was not provided.',
    };
  }

  // No exception — normal flow
  return {
    action: ExceptionAction.APPROVE,
    code:   'NO_EXCEPTION',
    reason: 'No exception conditions detected.',
  };
}
