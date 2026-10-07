/**
 * Warehouse Service — PS-01 Phase C2
 *
 * Provides warehouse operations: receiving returned items and inspecting them.
 * Every call is an audit event (the caller is responsible for recording it).
 *
 * In a real deployment, these would post to a WMS (Warehouse Management System).
 * The interface (function signatures and return shapes) stays the same.
 */

import crypto from 'node:crypto';

/**
 * Record receipt of a returned item at the warehouse.
 * Returns { receiptId, returnId, receivedAt, condition, notes }
 */
export async function receiveItem({ returnId, condition = 'unknown', notes = '' } = {}) {
  if (!returnId) throw new Error('receiveItem: returnId is required');
  const receiptId = `RCV-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  return {
    receiptId,
    returnId,
    receivedAt: new Date().toISOString(),
    condition,
    notes,
    status: 'RECEIVED',
  };
}

/**
 * Inspect a received item and record the outcome.
 *
 * @param {object} opts
 * @param {string} opts.returnId
 * @param {'pass'|'fail'|'partial'} opts.outcome
 * @param {string} [opts.notes]
 * @param {boolean} [opts.damaged]   – true if item arrived damaged
 * @returns {{ inspectionId, returnId, outcome, damaged, notes, inspectedAt }}
 */
export async function inspectItem({ returnId, outcome = 'pass', notes = '', damaged = false } = {}) {
  if (!returnId) throw new Error('inspectItem: returnId is required');
  const VALID_OUTCOMES = new Set(['pass', 'fail', 'partial']);
  if (!VALID_OUTCOMES.has(outcome)) {
    throw new Error(`inspectItem: outcome must be one of ${[...VALID_OUTCOMES].join(', ')}`);
  }
  const inspectionId = `INS-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  return {
    inspectionId,
    returnId,
    outcome,
    damaged,
    notes,
    inspectedAt: new Date().toISOString(),
    refundEligible: outcome === 'pass' || (outcome === 'partial' && !damaged),
  };
}
