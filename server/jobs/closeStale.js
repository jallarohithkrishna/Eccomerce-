/**
 * Customer Re-engagement & Human Review SLA Job — PS-01 Phase C2
 *
 * 1. Closes stale returns where the case is in NEEDS_INFO and customer has
 *    not replied for > 7 days, sending a final notification and audit event.
 * 2. Never auto-closes HUMAN_REVIEW cases; instead, when a case in HUMAN_REVIEW
 *    exceeds 24 hours, marks `slaBreached: true` and logs an alert in `alerts`
 *    collection for staff, with NO state change.
 *
 * Query by status with where and limit(50).
 * Fully idempotent, state-machine validated, and accepts an injected clock.
 */

import * as returnStore from '../returns/store.js';
import { notify } from '../services/notifier.js';
import { createEvent, GENESIS_HASH } from '../returns/audit.js';
import { assertTransition, STATES } from '../returns/stateMachine.js';
import { createAlert } from '../returns/store.js';

export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;    // 7 days for NEEDS_INFO
export const HUMAN_REVIEW_SLA_MS = 24 * 60 * 60 * 1000;       // 24 hours for HUMAN_REVIEW

/**
 * Process stale NEEDS_INFO cases and SLA breaches for HUMAN_REVIEW.
 *
 * @param {object|null} db – Firestore Admin SDK instance (or null in tests)
 * @param {object} [options]
 * @param {function} [options.clock] – Timestamp generator function (defaults to Date.now)
 * @returns {Promise<{ closed: string[], alerted: string[], errors: string[] }>}
 */
export async function closeStaleReturns(db, { clock = Date.now } = {}) {
  const results = { closed: [], alerted: [], errors: [] };
  const currentTime = typeof clock === 'function' ? clock() : Number(clock);
  const nowIso = new Date(currentTime).toISOString();

  // 1. Process NEEDS_INFO -> CLOSED_STALE (> 7 days)
  let needsInfoCases = [];
  try {
    needsInfoCases = await returnStore.listReturns({ db, status: STATES.NEEDS_INFO, limitN: 50 });
  } catch (err) {
    results.errors.push(`listReturns(NEEDS_INFO) failed: ${err.message}`);
  }

  const needsInfoCutoff = currentTime - STALE_THRESHOLD_MS;

  for (const ret of needsInfoCases) {
    try {
      const updatedAtMs = new Date(ret.updatedAt || ret.createdAt || 0).getTime();
      if (updatedAtMs > needsInfoCutoff) continue; // Not stale yet

      // Validate transition through state machine
      assertTransition(STATES.NEEDS_INFO, STATES.CLOSED_STALE);

      const closedRecord = {
        ...ret,
        status: STATES.CLOSED_STALE,
        updatedAt: nowIso,
        closedAt: nowIso,
        closeReason: 'No customer reply for 7+ days',
      };

      const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
      const seq = events.length + 1;
      const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
      const event = createEvent({
        returnId: ret.id,
        action: 'CLOSED_STALE',
        actor: 'system',
        data: { reason: 'No customer reply for 7+ days', closedAt: nowIso },
        previousHash,
      });
      event.seq = seq;
      event.prevHash = previousHash;

      await returnStore.saveReturn({ db, returnRecord: closedRecord, event });

      // Notify customer
      await notify({
        db,
        returnId: ret.id,
        toUserId: ret.userId,
        toEmail: ret.customerEmail || '',
        subject: 'Your return request has been closed',
        body: `Your return request (${ret.rma_number || ret.id}) has been closed because we did not receive a response within 7 days. If you still need help, please open a new request.`,
      });

      results.closed.push(ret.id);
    } catch (err) {
      results.errors.push(`${ret.id}: ${err.message}`);
    }
  }

  // 2. Process HUMAN_REVIEW SLA Breaches (> 24 hours) - NEVER auto-close
  let humanReviewCases = [];
  try {
    humanReviewCases = await returnStore.listReturns({ db, status: STATES.HUMAN_REVIEW, limitN: 50 });
  } catch (err) {
    results.errors.push(`listReturns(HUMAN_REVIEW) failed: ${err.message}`);
  }

  const humanReviewCutoff = currentTime - HUMAN_REVIEW_SLA_MS;

  for (const ret of humanReviewCases) {
    try {
      // If SLA breach is already flagged, skip (idempotency)
      if (ret.slaBreached) continue;

      const reviewEnteredMs = new Date(ret.reviewRequestedAt || ret.updatedAt || ret.createdAt || 0).getTime();
      if (reviewEnteredMs > humanReviewCutoff) continue; // Within SLA

      // Update flag, NO STATE CHANGE
      const updatedRecord = {
        ...ret,
        slaBreached: true,
        slaBreachedAt: nowIso,
        updatedAt: nowIso,
      };

      const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
      const seq = events.length + 1;
      const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
      const event = createEvent({
        returnId: ret.id,
        action: 'SLA_BREACHED',
        actor: 'system',
        data: {
          sla: 'HUMAN_REVIEW_24H',
          enteredAt: new Date(reviewEnteredMs).toISOString(),
          breachedAt: nowIso,
        },
        previousHash,
      });
      event.seq = seq;
      event.prevHash = previousHash;

      await returnStore.saveReturn({ db, returnRecord: updatedRecord, event });

      // Write staff alert
      await createAlert({
        db,
        alert: {
          type: 'SLA_BREACH',
          subtype: 'HUMAN_REVIEW_24H',
          returnId: ret.id,
          rma_number: ret.rma_number || null,
          severity: 'HIGH',
          message: `Return ${ret.rma_number || ret.id} in HUMAN_REVIEW has exceeded the 24-hour response SLA.`,
          createdAt: nowIso,
        },
      });

      results.alerted.push(ret.id);
    } catch (err) {
      results.errors.push(`${ret.id}: ${err.message}`);
    }
  }

  return results;
}
