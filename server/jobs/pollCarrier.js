/**
 * Mock Carrier Poller Job — PS-01 Phase C2
 *
 * Polls the mock carrier for tracking events for returns in IN_TRANSIT state,
 * advances the state machine when a DELIVERED event is received, and records
 * an audit event per transition.
 *
 * All state changes are validated strictly through `assertTransition(STATES.IN_TRANSIT, STATES.RECEIVED)`.
 * Queries returns by status with limit(50).
 * Triggered by the scheduler (ENABLE_JOBS=1) every 15 minutes.
 * Accepts an injected clock for deterministic time testing.
 */

import * as returnStore from '../returns/store.js';
import { createEvent, GENESIS_HASH } from '../returns/audit.js';
import { assertTransition, STATES } from '../returns/stateMachine.js';
import { emitTrackingEvent } from '../services/carrier.js';

/**
 * Poll carrier for all IN_TRANSIT returns and advance to RECEIVED when delivered.
 *
 * @param {object|null} db
 * @param {object} [options]
 * @param {function} [options.clock]
 * @param {boolean} [options.mockAlwaysDeliver]
 * @returns {Promise<{ advanced: string[], skipped: string[], errors: string[] }>}
 */
export async function pollCarrier(db, { clock = Date.now, mockAlwaysDeliver } = {}) {
  const results = { advanced: [], skipped: [], errors: [] };
  const currentTime = typeof clock === 'function' ? clock() : Number(clock);
  const nowIso = new Date(currentTime).toISOString();

  let inTransit;
  try {
    inTransit = await returnStore.listReturns({ db, status: STATES.IN_TRANSIT, limitN: 50 });
  } catch (err) {
    results.errors.push(`listReturns failed: ${err.message}`);
    return results;
  }

  for (const ret of inTransit) {
    try {
      // Simulate polling mock carrier
      const trackingEvent = await _pollCarrierApi(ret, mockAlwaysDeliver);
      if (!trackingEvent || trackingEvent.event !== 'DELIVERED') {
        results.skipped.push(ret.id);
        continue;
      }

      // Validate the state machine allows this transition
      assertTransition(STATES.IN_TRANSIT, STATES.RECEIVED);

      const updatedRecord = {
        ...ret,
        status: STATES.RECEIVED,
        receivedAt: nowIso,
        updatedAt: nowIso,
      };

      const events = await returnStore.getAuditEvents({ db, returnId: ret.id });
      const seq = events.length + 1;
      const previousHash = events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH;
      const event = createEvent({
        returnId: ret.id,
        action: 'CARRIER_DELIVERED',
        actor: 'carrier-poller',
        data: { trackingEvent, mock: true },
        previousHash,
      });
      event.seq = seq;
      event.prevHash = previousHash;

      await returnStore.saveReturn({ db, returnRecord: updatedRecord, event });
      results.advanced.push(ret.id);
      console.log(`[MOCK_CARRIER] Advanced return ${ret.rma_number || ret.id} (IN_TRANSIT -> RECEIVED)`);
    } catch (err) {
      results.errors.push(`${ret.id}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Mock carrier API poll.
 *
 * @param {object} ret – the return record
 * @param {boolean} [mockAlwaysDeliver]
 * @returns {Promise<{status: string, event: string}|null>}
 */
async function _pollCarrierApi(ret, mockAlwaysDeliver) {
  if (mockAlwaysDeliver || process.env.MOCK_CARRIER_ALWAYS_DELIVER === '1') {
    return emitTrackingEvent({ returnId: ret.id, event: 'DELIVERED', location: 'Warehouse Central Receiving' });
  }
  // Randomly simulate 1-in-3 probability for demo runs
  if (Math.random() < 0.33) {
    return { status: 'DELIVERED', event: 'DELIVERED' };
  }
  return null;
}
