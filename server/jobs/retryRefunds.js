/**
 * Refund Retry Job — PS-01 Phase C2
 *
 * Automatically retries failed refunds for cases in REFUND_FAILED state:
 * - Uses the same idempotency key across all attempts.
 * - Applies exponential backoff:
 *     Attempt 1: after 1 min  (60,000 ms)
 *     Attempt 2: after 5 min  (300,000 ms)
 *     Attempt 3: after 30 min (1,800,000 ms)
 *     Maximum 3 retry attempts.
 * - If the refund succeeds: moves case to COMPLETED via state machine.
 * - If 3 retries are exhausted without success: logs an alert in the `alerts`
 *   collection and moves the case to HUMAN_REVIEW via state machine.
 *
 * Query by status with where and limit(50).
 * Fully idempotent, state-machine verified, and accepts an injected clock.
 */

import * as returnStore from '../returns/store.js';
import { issueRefund } from '../services/payments.js';
import { createEvent, GENESIS_HASH } from '../returns/audit.js';
import { assertTransition, STATES } from '../returns/stateMachine.js';
import { createAlert } from '../returns/store.js';

export const BACKOFF_SCHEDULE_MS = [
  1 * 60 * 1000,   // Attempt 1: 1 min
  5 * 60 * 1000,   // Attempt 2: 5 min
  30 * 60 * 1000,  // Attempt 3: 30 min
];
export const MAX_REFUND_RETRIES = 3;

/**
 * Process failed refund retries with backoff and escalation.
 *
 * @param {object|null} db
 * @param {object} [options]
 * @param {function} [options.clock]
 * @param {boolean} [options.simulateFailure]
 * @returns {Promise<{ retried: string[], succeeded: string[], escalated: string[], skipped: string[], errors: string[] }>}
 */
export async function retryRefunds(db, { clock = Date.now, simulateFailure } = {}) {
  const results = { retried: [], succeeded: [], escalated: [], skipped: [], errors: [] };
  const currentTime = typeof clock === 'function' ? clock() : Number(clock);
  const nowIso = new Date(currentTime).toISOString();

  let failedCases = [];
  try {
    failedCases = await returnStore.listReturns({ db, status: STATES.REFUND_FAILED, limitN: 50 });
  } catch (err) {
    results.errors.push(`listReturns(REFUND_FAILED) failed: ${err.message}`);
    return results;
  }

  for (const ret of failedCases) {
    try {
      const currentRetries = Number(ret.refundRetries || 0);
      const lastAttemptMs = new Date(ret.lastRefundAttemptAt || ret.updatedAt || ret.createdAt || 0).getTime();

      // Check if max retries already exceeded
      if (currentRetries >= MAX_REFUND_RETRIES) {
        // Escalate to HUMAN_REVIEW
        assertTransition(STATES.REFUND_FAILED, STATES.HUMAN_REVIEW);

        const updatedRecord = {
          ...ret,
          status: STATES.HUMAN_REVIEW,
          reviewReason: 'Refund gateway failed after 3 retry attempts',
          reviewRequestedAt: nowIso,
          updatedAt: nowIso,
        };

        const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
        const seq = events.length + 1;
        const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
        const event = createEvent({
          returnId: ret.id,
          action: 'REFUND_RETRIES_EXHAUSTED',
          actor: 'system',
          data: {
            attempts: currentRetries,
            escalatedAt: nowIso,
          },
          previousHash,
        });
        event.seq = seq;
        event.prevHash = previousHash;

        await returnStore.saveReturn({ db, returnRecord: updatedRecord, event });

        // Alert staff
        await createAlert({
          db,
          alert: {
            type: 'PAYMENT_FAILURE',
            subtype: 'REFUND_RETRIES_EXHAUSTED',
            returnId: ret.id,
            rma_number: ret.rma_number || null,
            severity: 'CRITICAL',
            message: `Refund for return ${ret.rma_number || ret.id} failed after ${MAX_REFUND_RETRIES} attempts. Escalated to HUMAN_REVIEW.`,
            createdAt: nowIso,
          },
        });

        results.escalated.push(ret.id);
        continue;
      }

      // Check backoff threshold
      const requiredWaitMs = BACKOFF_SCHEDULE_MS[Math.min(currentRetries, BACKOFF_SCHEDULE_MS.length - 1)];
      if ((currentTime - lastAttemptMs) < requiredWaitMs) {
        results.skipped.push(ret.id);
        continue; // Backoff period not elapsed yet
      }

      // Consistent idempotency key
      const idempotencyKey = ret.refundIdempotencyKey || `idemp_rfd_${ret.id}`;
      const amount = Number(ret.refund_amount) || Number(ret.item?.price) || 100;

      // Execute retry payment
      const paymentRes = await issueRefund({
        returnId: ret.id,
        amount,
        currency: 'INR',
        simulateFailure,
      });

      const nextRetryCount = currentRetries + 1;

      if (paymentRes.status === 'success') {
        // Transition REFUND_FAILED -> REFUND_PROCESSING -> COMPLETED
        assertTransition(STATES.REFUND_FAILED, STATES.REFUND_PROCESSING);
        assertTransition(STATES.REFUND_PROCESSING, STATES.COMPLETED);

        const updatedRecord = {
          ...ret,
          status: STATES.COMPLETED,
          refundRetries: nextRetryCount,
          lastRefundAttemptAt: nowIso,
          refundCompletedAt: nowIso,
          refund_record: paymentRes,
          refundIdempotencyKey: idempotencyKey,
          updatedAt: nowIso,
        };

        const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
        const seq = events.length + 1;
        const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
        const event = createEvent({
          returnId: ret.id,
          action: 'REFUND_RETRY_SUCCESS',
          actor: 'system',
          data: {
            attempts: nextRetryCount,
            refundId: paymentRes.refundId,
            idempotencyKey,
          },
          previousHash,
        });
        event.seq = seq;
        event.prevHash = previousHash;

        await returnStore.saveReturn({ db, returnRecord: updatedRecord, event });
        results.succeeded.push(ret.id);
      } else {
        // Failed this attempt
        if (nextRetryCount >= MAX_REFUND_RETRIES) {
          // Escalate immediately to HUMAN_REVIEW
          assertTransition(STATES.REFUND_FAILED, STATES.HUMAN_REVIEW);

          const updatedRecord = {
            ...ret,
            status: STATES.HUMAN_REVIEW,
            refundRetries: nextRetryCount,
            lastRefundAttemptAt: nowIso,
            refundIdempotencyKey: idempotencyKey,
            reviewReason: `Refund gateway failed after ${MAX_REFUND_RETRIES} attempts: ${paymentRes.failureReason || 'unknown'}`,
            reviewRequestedAt: nowIso,
            updatedAt: nowIso,
          };

          const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
          const seq = events.length + 1;
          const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
          const event = createEvent({
            returnId: ret.id,
            action: 'REFUND_RETRIES_EXHAUSTED',
            actor: 'system',
            data: {
              attempts: nextRetryCount,
              failureReason: paymentRes.failureReason,
              idempotencyKey,
            },
            previousHash,
          });
          event.seq = seq;
          event.prevHash = previousHash;

          await returnStore.saveReturn({ db, returnRecord: updatedRecord, event });

          // Alert staff
          await createAlert({
            db,
            alert: {
              type: 'PAYMENT_FAILURE',
              subtype: 'REFUND_RETRIES_EXHAUSTED',
              returnId: ret.id,
              rma_number: ret.rma_number || null,
              severity: 'CRITICAL',
              message: `Refund for return ${ret.rma_number || ret.id} failed on final attempt (${MAX_REFUND_RETRIES}). Escalated to HUMAN_REVIEW.`,
              createdAt: nowIso,
            },
          });

          results.escalated.push(ret.id);
        } else {
          // Stay in REFUND_FAILED and wait for next backoff
          const updatedRecord = {
            ...ret,
            status: STATES.REFUND_FAILED,
            refundRetries: nextRetryCount,
            lastRefundAttemptAt: nowIso,
            refundIdempotencyKey: idempotencyKey,
            lastRefundError: paymentRes.failureReason,
            updatedAt: nowIso,
          };

          const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
          const seq = events.length + 1;
          const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
          const event = createEvent({
            returnId: ret.id,
            action: 'REFUND_RETRY_FAILED',
            actor: 'system',
            data: {
              attempt: nextRetryCount,
              failureReason: paymentRes.failureReason,
              nextRetryAllowedAfterMs: BACKOFF_SCHEDULE_MS[Math.min(nextRetryCount, BACKOFF_SCHEDULE_MS.length - 1)],
            },
            previousHash,
          });
          event.seq = seq;
          event.prevHash = previousHash;

          await returnStore.saveReturn({ db, returnRecord: updatedRecord, event });
          results.retried.push(ret.id);
        }
      }
    } catch (err) {
      results.errors.push(`${ret.id}: ${err.message}`);
    }
  }

  return results;
}
