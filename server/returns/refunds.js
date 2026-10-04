/**
 * Idempotent Saga-Style Refund Module — PS-01
 * 
 * Rules:
 * - Each return ID can only have ONE successful refund. Repeated calls with the
 *   same returnId and amount are ignored (idempotent).
 * - A refund that was already completed with a DIFFERENT amount throws.
 * - Compensating transaction (cancel) is allowed for PENDING refunds only.
 * - The actual payment call is mocked; replace paymentGateway.charge() with real SDK.
 */

/** In-memory idempotency store. In production, use a Firestore `refunds` collection. */
const refundLedger = new Map(); // returnId → RefundRecord

/**
 * @typedef {Object} RefundRecord
 * @property {string} returnId
 * @property {number} amount
 * @property {string} status  - 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'FAILED'
 * @property {string} method  - 'original_payment' | 'store_credit' | 'bank_transfer'
 * @property {string} transactionId
 * @property {string} initiatedAt
 * @property {string} [completedAt]
 * @property {string} [cancelledAt]
 * @property {string} [failureReason]
 */

// ── Mock payment gateway (replace with real SDK) ──────────────────────────
const paymentGateway = {
  /**
   * Simulate a refund. Returns a transaction ID or throws on failure.
   */
  async charge({ returnId, amount, method }) {
    // Simulate 5% random failure rate for demo
    if (Math.random() < 0.05) {
      throw new Error('Payment gateway timeout. Retry later.');
    }
    return `TXN-${returnId.slice(-6).toUpperCase()}-${Date.now()}`;
  },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initiate a refund for a return case.
 * Idempotent: calling with the same returnId + amount while COMPLETED → returns existing record.
 *
 * @param {Object} params
 * @param {string} params.returnId
 * @param {number} params.amount      - Refund amount in INR
 * @param {string} params.method      - 'original_payment' | 'store_credit' | 'bank_transfer'
 * @param {string} params.initiatedBy - UID of agent/staff initiating the refund
 * @returns {Promise<RefundRecord>}
 */
export async function initiateRefund({ returnId, amount, method = 'original_payment', initiatedBy }) {
  if (!returnId) throw new Error('returnId is required');
  if (!amount || amount <= 0) throw new Error('amount must be a positive number');

  const existing = refundLedger.get(returnId);

  // Idempotency: same amount already completed → return existing
  if (existing) {
    if (existing.status === 'COMPLETED' && existing.amount === amount) {
      return existing;
    }
    if (existing.status === 'COMPLETED' && existing.amount !== amount) {
      throw new Error(
        `Refund for ${returnId} already completed with amount ₹${existing.amount}. Cannot re-issue with different amount ₹${amount}.`
      );
    }
    if (existing.status === 'PENDING') {
      // Duplicate request while already pending — return the pending record
      return existing;
    }
  }

  const record = {
    returnId,
    amount,
    status: 'PENDING',
    method,
    transactionId: null,
    initiatedAt: new Date().toISOString(),
    initiatedBy,
    completedAt: null,
    cancelledAt: null,
    failureReason: null,
  };

  refundLedger.set(returnId, record);

  // Attempt payment
  try {
    const txId = await paymentGateway.charge({ returnId, amount, method });
    record.status        = 'COMPLETED';
    record.transactionId = txId;
    record.completedAt   = new Date().toISOString();
  } catch (err) {
    record.status        = 'FAILED';
    record.failureReason = err.message;
    // Do NOT delete from ledger — failed refunds must remain visible for retry/alert
  }

  refundLedger.set(returnId, record);
  return record;
}

/**
 * Retry a FAILED refund (compensating step).
 * @param {string} returnId
 * @returns {Promise<RefundRecord>}
 */
export async function retryRefund(returnId) {
  const existing = refundLedger.get(returnId);
  if (!existing) throw new Error(`No refund record found for ${returnId}`);
  if (existing.status === 'COMPLETED') return existing;
  if (existing.status === 'CANCELLED') throw new Error(`Refund for ${returnId} was cancelled and cannot be retried.`);

  existing.status        = 'PENDING';
  existing.failureReason = null;
  refundLedger.set(returnId, existing);

  try {
    const txId = await paymentGateway.charge({
      returnId: existing.returnId,
      amount: existing.amount,
      method: existing.method,
    });
    existing.status        = 'COMPLETED';
    existing.transactionId = txId;
    existing.completedAt   = new Date().toISOString();
  } catch (err) {
    existing.status        = 'FAILED';
    existing.failureReason = err.message;
  }

  refundLedger.set(returnId, existing);
  return existing;
}

/**
 * Cancel a PENDING refund (saga compensation).
 * @param {string} returnId
 * @returns {RefundRecord}
 */
export function cancelRefund(returnId) {
  const existing = refundLedger.get(returnId);
  if (!existing) throw new Error(`No refund record found for ${returnId}`);
  if (existing.status !== 'PENDING') {
    throw new Error(`Can only cancel PENDING refunds. Current status: ${existing.status}`);
  }
  existing.status      = 'CANCELLED';
  existing.cancelledAt = new Date().toISOString();
  refundLedger.set(returnId, existing);
  return existing;
}

/**
 * Get the current refund record for a return (or null).
 * @param {string} returnId
 * @returns {RefundRecord|null}
 */
export function getRefund(returnId) {
  return refundLedger.get(returnId) || null;
}

/** Expose ledger for test inspection */
export function _ledger() { return refundLedger; }
