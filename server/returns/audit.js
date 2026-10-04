/**
 * Hash-Chained Audit Log — PS-01
 * Append-only event chain using SHA-256.
 * Each event stores a hash of: previous_hash + event_data.
 * Tamper is detectable by re-computing the chain.
 *
 * No side-effects. Caller persists events to Firestore using Admin SDK.
 */

import { createHash } from 'crypto';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Create a new audit event object ready to be appended.
 *
 * @param {Object} params
 * @param {string} params.returnId     - Return case ID
 * @param {string} params.previousHash - Hash of the preceding event (GENESIS_HASH for first)
 * @param {string} params.actor        - User UID or 'system' or 'llm-agent'
 * @param {string} params.action       - e.g. 'STATE_TRANSITION', 'REFUND_INITIATED', 'OVERRIDE'
 * @param {Object} params.data         - Arbitrary structured payload
 * @param {string} [params.isoTimestamp] - Override timestamp (for tests); defaults to now
 * @returns {{ hash: string, previousHash: string, returnId: string, actor: string, action: string, data: Object, timestamp: string }}
 */
export function createEvent({ returnId, previousHash, actor, action, data, isoTimestamp }) {
  if (!returnId)     throw new Error('returnId is required');
  if (!actor)        throw new Error('actor is required');
  if (!action)       throw new Error('action is required');
  if (previousHash === undefined || previousHash === null) {
    throw new Error('previousHash is required (use GENESIS_HASH for first event)');
  }

  const timestamp = isoTimestamp || new Date().toISOString();
  const payload   = JSON.stringify({ returnId, previousHash, actor, action, data, timestamp });
  const hash      = createHash('sha256').update(payload).digest('hex');

  return { hash, previousHash, returnId, actor, action, data, timestamp };
}

/**
 * Verify an ordered array of audit events (first to last).
 * Returns { valid: true } or { valid: false, firstBadIndex: N, reason: string }.
 *
 * @param {Array} events - Ordered array of event objects from createEvent()
 * @returns {{ valid: boolean, firstBadIndex?: number, reason?: string }}
 */
export function verifyChain(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { valid: true }; // empty chain is trivially valid
  }

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    // Re-compute expected hash
    const payload  = JSON.stringify({
      returnId:     ev.returnId,
      previousHash: ev.previousHash,
      actor:        ev.actor,
      action:       ev.action,
      data:         ev.data,
      timestamp:    ev.timestamp,
    });
    const expected = createHash('sha256').update(payload).digest('hex');

    if (ev.hash !== expected) {
      return { valid: false, firstBadIndex: i, reason: `Event[${i}] hash mismatch. Expected ${expected}, got ${ev.hash}` };
    }

    // Chain linkage check (skip for first event)
    if (i > 0 && ev.previousHash !== events[i - 1].hash) {
      return {
        valid: false,
        firstBadIndex: i,
        reason: `Event[${i}] previousHash does not match Event[${i - 1}] hash`,
      };
    }
  }

  return { valid: true };
}
