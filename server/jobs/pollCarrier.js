/**
 * Mock Carrier Poller Job — PS-01 Phase C2
 *
 * Polls the mock carrier for tracking events for returns in IN_TRANSIT state,
 * advances the state machine when a DELIVERED event is received, and records
 * an audit event per transition.
 *
 * In production, replace `_pollCarrierApi` with real carrier API calls.
 * Triggered by the scheduler (ENABLE_JOBS=1) every 15 minutes.
 */

import * as returnStore from '../returns/store.js';
import { createEvent, GENESIS_HASH } from '../returns/audit.js';
import { assertTransition, STATES } from '../returns/stateMachine.js';
import { emitTrackingEvent } from '../services/carrier.js';

/**
 * Poll carrier for all IN_TRANSIT returns and advance to RECEIVED when delivered.
 *
 * @param {object|null} db
 * @returns {Promise<{ advanced: string[], skipped: string[], errors: string[] }>}
 */
export async function pollCarrier(db) {
  const results = { advanced: [], skipped: [], errors: [] };

  let inTransit;
  try {
    inTransit = await returnStore.listReturns({ db, status: STATES.IN_TRANSIT, limitN: 200 });
  } catch (err) {
    results.errors.push(`listReturns failed: ${err.message}`);
    return results;
  }

  for (const ret of inTransit) {
    try {
      // Simulate polling the carrier — in production this would be an HTTP call.
      const trackingEvent = await _pollCarrierApi(ret);
      if (!trackingEvent || trackingEvent.event !== 'DELIVERED') {
        results.skipped.push(ret.id);
        continue;
      }

      // Validate the state machine allows this transition
      assertTransition(STATES.IN_TRANSIT, STATES.RECEIVED);

      const updatedRecord = {
        ...ret,
        status: STATES.RECEIVED,
        receivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
      const seq = events.length + 1;
      const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
      const event = createEvent({
        returnId: ret.id,
        action: 'CARRIER_DELIVERED',
        actor: 'carrier-poller',
        data: { trackingEvent },
        previousHash,
      });
      event.seq = seq;
      event.prevHash = previousHash;

      await returnStore.saveReturn({ db, returnRecord: updatedRecord, event });
      results.advanced.push(ret.id);
    } catch (err) {
      results.errors.push(`${ret.id}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Mock carrier API poll.
 * Returns a delivery event 33% of the time, null otherwise.
 * Replace this with real carrier API calls in production.
 *
 * @param {object} ret – the return record
 * @returns {Promise<{status: string}|null>}
 */
async function _pollCarrierApi(ret) {
  if (process.env.MOCK_CARRIER_ALWAYS_DELIVER === '1') {
    return emitTrackingEvent({ returnId: ret.id, event: 'DELIVERED', location: 'Warehouse' });
  }
  // Randomly simulate 1-in-3 probability for demo
  if (Math.random() < 0.33) {
    return { status: 'DELIVERED' };
  }
  return null;
}
