/**
 * Payments Service — PS-01 Phase C2
 *
 * Simulates payment gateway operations for refunds.
 * Set SIMULATE_PAYMENT_FAILURE=1 to trigger the failure path for testing.
 *
 * Every call is an audit event (the caller is responsible for recording it).
 */

import crypto from 'node:crypto';

/**
 * @typedef {Object} RefundResult
 * @property {string}  refundId
 * @property {string}  returnId
 * @property {number}  amount
 * @property {'success'|'failed'|'pending'} status
 * @property {string}  [failureReason]
 * @property {string}  processedAt
 */

/**
 * Issue a refund for a return.
 *
 * @param {object}  opts
 * @param {string}  opts.returnId
 * @param {number}  opts.amount          – amount in the smallest currency unit (e.g. paise / cents)
 * @param {string}  [opts.currency]      – ISO-4217 currency code, default 'INR'
 * @param {boolean} [opts.simulateFailure] – if true, the gateway always fails (for testing)
 * @returns {Promise<RefundResult>}
 */
export async function issueRefund({ returnId, amount, currency = 'INR', simulateFailure } = {}) {
  if (!returnId) throw new Error('issueRefund: returnId is required');
  if (typeof amount !== 'number' || amount <= 0) {
    throw new Error('issueRefund: amount must be a positive number');
  }

  const shouldFail =
    simulateFailure === true ||
    process.env.SIMULATE_PAYMENT_FAILURE === '1';

  const refundId = `RFD-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  if (shouldFail) {
    /** @type {RefundResult} */
    return {
      refundId,
      returnId,
      amount,
      currency,
      status: 'failed',
      failureReason: 'gateway_timeout',
      processedAt: new Date().toISOString(),
    };
  }

  /** @type {RefundResult} */
  return {
    refundId,
    returnId,
    amount,
    currency,
    status: 'success',
    processedAt: new Date().toISOString(),
  };
}
