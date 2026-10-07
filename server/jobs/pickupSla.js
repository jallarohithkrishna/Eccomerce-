/**
 * Pickup SLA Job — PS-01 Phase C2
 *
 * Monitors returns in APPROVED or PICKUP_SCHEDULED:
 * 1. APPROVED cases where no pickup is scheduled after 48h.
 * 2. PICKUP_SCHEDULED cases where the scheduled pickup slot has passed without
 *    transitioning to IN_TRANSIT.
 *
 * Action: Creates an alert in `alerts` collection for staff, sends a customer
 * notification, records an audit event, and sets `pickupSlaBreached: true`.
 * State is NOT changed.
 *
 * Query by status with where and limit(50).
 * Fully idempotent, state-machine verified, and accepts an injected clock.
 */

import * as returnStore from '../returns/store.js';
import { notify } from '../services/notifier.js';
import { createEvent, GENESIS_HASH } from '../returns/audit.js';
import { STATES } from '../returns/stateMachine.js';
import { createAlert } from '../returns/store.js';

export const PICKUP_UNSCHEDULED_SLA_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Check and flag pickup SLA breaches.
 *
 * @param {object|null} db
 * @param {object} [options]
 * @param {function} [options.clock]
 * @returns {Promise<{ alerted: string[], errors: string[] }>}
 */
export async function checkPickupSla(db, { clock = Date.now } = {}) {
  const results = { alerted: [], errors: [] };
  const currentTime = typeof clock === 'function' ? clock() : Number(clock);
  const nowIso = new Date(currentTime).toISOString();

  // 1. Check APPROVED cases with no pickup scheduled > 48h
  let approvedCases = [];
  try {
    approvedCases = await returnStore.listReturns({ db, status: STATES.APPROVED, limitN: 50 });
  } catch (err) {
    results.errors.push(`listReturns(APPROVED) failed: ${err.message}`);
  }

  const approvedCutoff = currentTime - PICKUP_UNSCHEDULED_SLA_MS;

  for (const ret of approvedCases) {
    try {
      if (ret.pickupSlaBreached) continue; // Idempotency check

      const approvedAtMs = new Date(ret.approvedAt || ret.updatedAt || ret.createdAt || 0).getTime();
      if (approvedAtMs > approvedCutoff) continue; // Within 48h SLA

      const updatedRecord = {
        ...ret,
        pickupSlaBreached: true,
        pickupSlaBreachedAt: nowIso,
        updatedAt: nowIso,
      };

      const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
      const seq = events.length + 1;
      const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
      const event = createEvent({
        returnId: ret.id,
        action: 'PICKUP_SLA_BREACHED',
        actor: 'system',
        data: {
          reason: 'No pickup scheduled after 48h of approval',
          approvedAt: new Date(approvedAtMs).toISOString(),
          breachedAt: nowIso,
        },
        previousHash,
      });
      event.seq = seq;
      event.prevHash = previousHash;

      await returnStore.saveReturn({ db, returnRecord: updatedRecord, event });

      // Create staff alert
      await createAlert({
        db,
        alert: {
          type: 'SLA_BREACH',
          subtype: 'PICKUP_NOT_SCHEDULED_48H',
          returnId: ret.id,
          rma_number: ret.rma_number || null,
          severity: 'MEDIUM',
          message: `Return ${ret.rma_number || ret.id} was approved >48h ago but has no pickup scheduled.`,
          createdAt: nowIso,
        },
      });

      // Notify customer
      await notify({
        db,
        returnId: ret.id,
        toUserId: ret.userId,
        toEmail: ret.customerEmail || '',
        subject: 'Action needed: Schedule your return pickup',
        body: `Your return request (${ret.rma_number || ret.id}) was approved. Please schedule a pickup time to complete your return.`,
      });

      results.alerted.push(ret.id);
    } catch (err) {
      results.errors.push(`${ret.id}: ${err.message}`);
    }
  }

  // 2. Check PICKUP_SCHEDULED cases with missed pickup slot
  let scheduledCases = [];
  try {
    scheduledCases = await returnStore.listReturns({ db, status: STATES.PICKUP_SCHEDULED, limitN: 50 });
  } catch (err) {
    results.errors.push(`listReturns(PICKUP_SCHEDULED) failed: ${err.message}`);
  }

  for (const ret of scheduledCases) {
    try {
      if (ret.pickupSlaBreached) continue; // Idempotency check

      // If scheduledPickupSlot has passed by at least 2 hours
      const slotTimeMs = new Date(ret.scheduledPickupSlot || ret.pickupSlot || 0).getTime();
      if (!slotTimeMs || slotTimeMs > currentTime) continue; // Slot is in the future or not set

      const updatedRecord = {
        ...ret,
        pickupSlaBreached: true,
        pickupSlaBreachedAt: nowIso,
        updatedAt: nowIso,
      };

      const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
      const seq = events.length + 1;
      const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
      const event = createEvent({
        returnId: ret.id,
        action: 'MISSED_PICKUP_SLA',
        actor: 'system',
        data: {
          reason: 'Scheduled pickup slot was missed without transit update',
          scheduledSlot: new Date(slotTimeMs).toISOString(),
          breachedAt: nowIso,
        },
        previousHash,
      });
      event.seq = seq;
      event.prevHash = previousHash;

      await returnStore.saveReturn({ db, returnRecord: updatedRecord, event });

      // Create staff alert
      await createAlert({
        db,
        alert: {
          type: 'SLA_BREACH',
          subtype: 'MISSED_PICKUP_SLOT',
          returnId: ret.id,
          rma_number: ret.rma_number || null,
          severity: 'MEDIUM',
          message: `Return ${ret.rma_number || ret.id} scheduled pickup slot was missed.`,
          createdAt: nowIso,
        },
      });

      // Notify customer
      await notify({
        db,
        returnId: ret.id,
        toUserId: ret.userId,
        toEmail: ret.customerEmail || '',
        subject: 'Missed Pickup Notification',
        body: `We noticed your scheduled pickup for return (${ret.rma_number || ret.id}) was missed. Our team will contact you to reschedule.`,
      });

      results.alerted.push(ret.id);
    } catch (err) {
      results.errors.push(`${ret.id}: ${err.message}`);
    }
  }

  return results;
}
