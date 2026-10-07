/**
 * Carrier Service — PS-01 Phase C2
 *
 * Provides simulated carrier operations: label generation, pickup slot booking,
 * and tracking event emission. Every call is an audit event.
 *
 * In a real deployment, swap the internals for calls to the carrier's REST API.
 * The interface (function signatures and return shapes) stays the same.
 */

import crypto from 'node:crypto';

/**
 * Generate a shipping label for a return.
 * Returns { labelId, labelUrl, carrier, estimatedPickupWindow }
 */
export async function generateLabel({ returnId, address, carrier = 'MockCarrier' } = {}) {
  if (!returnId) throw new Error('generateLabel: returnId is required');
  const labelId = `LBL-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  return {
    labelId,
    labelUrl: `https://carrier.example.com/labels/${labelId}.pdf`,
    carrier,
    returnId,
    createdAt: new Date().toISOString(),
    estimatedPickupWindow: '09:00–18:00',
  };
}

/**
 * Book a pickup slot for a return.
 * Returns { slotId, scheduledAt, carrier, address }
 */
export async function bookPickupSlot({ returnId, address, preferredDate, carrier = 'MockCarrier' } = {}) {
  if (!returnId) throw new Error('bookPickupSlot: returnId is required');
  const slotId = `SLOT-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const scheduledAt = preferredDate
    ? new Date(preferredDate).toISOString()
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // default: tomorrow
  return {
    slotId,
    carrier,
    returnId,
    scheduledAt,
    address: address || 'address not provided',
    status: 'SCHEDULED',
  };
}

/**
 * Emit a tracking event for a return shipment.
 * @param {object} opts
 * @param {string} opts.returnId
 * @param {string} opts.event    – e.g. 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED'
 * @param {string} [opts.location]
 * @returns {{ eventId, returnId, event, location, timestamp }}
 */
export async function emitTrackingEvent({ returnId, event, location = 'Depot' } = {}) {
  if (!returnId) throw new Error('emitTrackingEvent: returnId is required');
  if (!event) throw new Error('emitTrackingEvent: event is required');
  const eventId = `TRK-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  return {
    eventId,
    returnId,
    event,
    location,
    timestamp: new Date().toISOString(),
  };
}
