/**
 * Customer Re-engagement Job — PS-01 Phase C2
 *
 * Closes stale returns where the customer has not replied for > 7 days,
 * sends a final in-app + email notification, and records an audit event.
 *
 * Triggered by the scheduler (ENABLE_JOBS=1) every hour.
 * Falls back gracefully if Firestore is unavailable.
 */

import * as returnStore from '../returns/store.js';
import { notify } from '../services/notifier.js';
import { createEvent, GENESIS_HASH } from '../returns/audit.js';

export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Close all returns in HUMAN_REVIEW that have not been updated in > 7 days.
 *
 * @param {object|null} db – Firestore Admin SDK instance (or null in tests)
 * @returns {Promise<{ closed: string[], errors: string[] }>}
 */
export async function closeStaleReturns(db) {
  const results = { closed: [], errors: [] };

  let staleReturns;
  try {
    staleReturns = await returnStore.listReturns({ db, status: 'HUMAN_REVIEW', limitN: 200 });
  } catch (err) {
    results.errors.push(`listReturns failed: ${err.message}`);
    return results;
  }

  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  for (const ret of staleReturns) {
    try {
      const updatedAt = new Date(ret.updatedAt || ret.createdAt || 0);
      if (updatedAt >= cutoff) continue; // not stale yet

      const now = new Date().toISOString();
      const closedRecord = {
        ...ret,
        status: 'CLOSED_STALE',
        updatedAt: now,
        closedAt: now,
        closeReason: 'No customer reply for 7+ days',
      };

      // Build and append audit event before saving
      const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
      const seq = events.length + 1;
      const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
      const event = createEvent({
        returnId: ret.id,
        action: 'CLOSED_STALE',
        actor: 'system',
        data: { reason: 'No customer reply for 7+ days', closedAt: closedRecord.closedAt },
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

  return results;
}
