/**
 * Warehouse Receipt SLA Job — PS-01 Phase C2
 *
 * Monitors returns in IN_TRANSIT:
 * If an item has been IN_TRANSIT for longer than 7 days without being received
 * at the warehouse, moves the case to HUMAN_REVIEW through the state machine
 * with the reason "trace needed", creates an audit event, logs an alert,
 * and notifies the customer.
 *
 * Query by status with where and limit(50).
 * Fully idempotent, state-machine verified, and accepts an injected clock.
 */

import * as returnStore from '../returns/store.js';
import { notify } from '../services/notifier.js';
import { createEvent, GENESIS_HASH } from '../returns/audit.js';
import { assertTransition, STATES } from '../returns/stateMachine.js';
import { createAlert } from '../returns/store.js';

export const IN_TRANSIT_SLA_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Check and process returns that have been IN_TRANSIT for > 7 days.
 *
 * @param {object|null} db
 * @param {object} [options]
 * @param {function} [options.clock]
 * @returns {Promise<{ escalated: string[], errors: string[] }>}
 */
export async function checkWarehouseReceiptSla(db, { clock = Date.now } = {}) {
  const results = { escalated: [], errors: [] };
  const currentTime = typeof clock === 'function' ? clock() : Number(clock);
  const nowIso = new Date(currentTime).toISOString();

  let inTransitCases = [];
  try {
    inTransitCases = await returnStore.listReturns({ db, status: STATES.IN_TRANSIT, limitN: 50 });
  } catch (err) {
    results.errors.push(`listReturns(IN_TRANSIT) failed: ${err.message}`);
    return results;
  }

  const inTransitCutoff = currentTime - IN_TRANSIT_SLA_MS;

  for (const ret of inTransitCases) {
    try {
      const inTransitAtMs = new Date(ret.inTransitAt || ret.updatedAt || ret.createdAt || 0).getTime();
      if (inTransitAtMs > inTransitCutoff) continue; // Within 7-day transit SLA

      // Enforce state machine transition
      assertTransition(STATES.IN_TRANSIT, STATES.HUMAN_REVIEW);

      const updatedRecord = {
        ...ret,
        status: STATES.HUMAN_REVIEW,
        reviewReason: 'trace needed',
        reviewRequestedAt: nowIso,
        updatedAt: nowIso,
      };

      const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
      const seq = events.length + 1;
      const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
      const event = createEvent({
        returnId: ret.id,
        action: 'TRANSIT_SLA_ESCALATED',
        actor: 'system',
        data: {
          reason: 'trace needed',
          inTransitSince: new Date(inTransitAtMs).toISOString(),
          escalatedAt: nowIso,
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
          subtype: 'IN_TRANSIT_DELAY',
          returnId: ret.id,
          rma_number: ret.rma_number || null,
          severity: 'HIGH',
          message: `Return ${ret.rma_number || ret.id} has been in transit >7 days without receipt. Carrier trace needed.`,
          createdAt: nowIso,
        },
      });

      // Notify customer
      await notify({
        db,
        returnId: ret.id,
        toUserId: ret.userId,
        toEmail: ret.customerEmail || '',
        subject: 'Update on your return delivery',
        body: `Your return package (${ret.rma_number || ret.id}) is experiencing shipping delays. Our support team is tracing the shipment and will update you shortly.`,
      });

      results.escalated.push(ret.id);
    } catch (err) {
      results.errors.push(`${ret.id}: ${err.message}`);
    }
  }

  return results;
}
