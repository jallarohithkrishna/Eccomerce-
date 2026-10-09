/**
 * Return State Machine — PS-01
 * Defines legal transitions; illegal jumps throw ReturnStateError.
 * No LLM dependency. Pure deterministic logic.
 */

import { createEvent, GENESIS_HASH } from './audit.js';
import * as returnStore from './store.js';
import { notify } from '../services/notifier.js';

export const STATES = Object.freeze({
  REQUESTED:           'REQUESTED',
  VERIFYING:           'VERIFYING',
  ELIGIBILITY_CHECK:   'ELIGIBILITY_CHECK',
  APPROVED:            'APPROVED',
  PICKUP_SCHEDULED:    'PICKUP_SCHEDULED',
  IN_TRANSIT:          'IN_TRANSIT',
  RECEIVED:            'RECEIVED',
  INSPECTION:          'INSPECTION',
  REFUND_PROCESSING:   'REFUND_PROCESSING',
  COMPLETED:           'COMPLETED',
  HUMAN_REVIEW:        'HUMAN_REVIEW',
  REJECTED:            'REJECTED',
  // Phase C2 additions
  NEEDS_INFO:          'NEEDS_INFO',        // waiting for customer to supply information
  CLOSED_STALE:        'CLOSED_STALE',      // auto-closed after 7+ days of no customer reply
  REFUND_FAILED:       'REFUND_FAILED',     // gateway failure; can retry or escalate
  REPLACEMENT_SHIPPED: 'REPLACEMENT_SHIPPED', // replacement item sent instead of refund
});

/**
 * The single appeal exception.
 * REJECTED stays terminal for every transition EXCEPT reopening the case for
 * human review. Everything else out of REJECTED is illegal forever.
 */
export const APPEAL_TRANSITION = Object.freeze({
  from: STATES.REJECTED,
  to:   STATES.HUMAN_REVIEW,
});

/** True when (from → to) is the appeal exception rather than a normal transition. */
export function isAppealTransition(from, to) {
  return from === APPEAL_TRANSITION.from && to === APPEAL_TRANSITION.to;
}

/**
 * Legal transitions: from → Set of allowed 'to' states
 */
const TRANSITION_MAP = {
  // Staff/agent may approve or reject a freshly filed case.
  [STATES.REQUESTED]:           new Set([STATES.VERIFYING, STATES.APPROVED, STATES.HUMAN_REVIEW, STATES.REJECTED, STATES.NEEDS_INFO]),
  [STATES.VERIFYING]:           new Set([STATES.ELIGIBILITY_CHECK, STATES.APPROVED, STATES.HUMAN_REVIEW, STATES.REJECTED, STATES.NEEDS_INFO]),
  [STATES.ELIGIBILITY_CHECK]:   new Set([STATES.APPROVED, STATES.HUMAN_REVIEW, STATES.REJECTED, STATES.NEEDS_INFO]),
  [STATES.APPROVED]:            new Set([STATES.PICKUP_SCHEDULED, STATES.HUMAN_REVIEW, STATES.REPLACEMENT_SHIPPED]),
  [STATES.PICKUP_SCHEDULED]:    new Set([STATES.IN_TRANSIT, STATES.HUMAN_REVIEW]),
  [STATES.IN_TRANSIT]:          new Set([STATES.RECEIVED, STATES.HUMAN_REVIEW]),
  [STATES.RECEIVED]:            new Set([STATES.INSPECTION, STATES.HUMAN_REVIEW]),
  [STATES.INSPECTION]:          new Set([STATES.REFUND_PROCESSING, STATES.HUMAN_REVIEW, STATES.REJECTED, STATES.REPLACEMENT_SHIPPED]),
  [STATES.REFUND_PROCESSING]:   new Set([STATES.COMPLETED, STATES.HUMAN_REVIEW, STATES.REFUND_FAILED]),
  [STATES.REFUND_FAILED]:       new Set([STATES.REFUND_PROCESSING, STATES.HUMAN_REVIEW, STATES.REJECTED]),
  [STATES.REPLACEMENT_SHIPPED]: new Set([STATES.COMPLETED]),
  [STATES.NEEDS_INFO]:          new Set([STATES.VERIFYING, STATES.ELIGIBILITY_CHECK, STATES.APPROVED, STATES.REJECTED, STATES.HUMAN_REVIEW, STATES.CLOSED_STALE]),
  [STATES.COMPLETED]:           new Set(), // terminal
  [STATES.CLOSED_STALE]:        new Set(), // terminal
  // Terminal except for the appeal exception (REJECTED → HUMAN_REVIEW).
  [STATES.REJECTED]:            new Set([STATES.HUMAN_REVIEW]),
  // HUMAN_REVIEW can transition back to any non-terminal state (manual override)
  [STATES.HUMAN_REVIEW]:        new Set([
    STATES.ELIGIBILITY_CHECK,
    STATES.APPROVED,
    STATES.PICKUP_SCHEDULED,
    STATES.REFUND_PROCESSING,
    STATES.REJECTED,
    STATES.COMPLETED,
    STATES.NEEDS_INFO,
    STATES.REFUND_FAILED,
    STATES.REPLACEMENT_SHIPPED,
  ]),
};

/**
 * Map legacy/lower-case status strings onto canonical STATES values so that
 * records written before this module existed can still be transitioned.
 * Unknown values are returned untouched (and will fail assertTransition).
 */
export function normalizeStatus(status) {
  if (!status || typeof status !== 'string') return status;
  if (TRANSITION_MAP[status]) return status;
  const upper = status.toUpperCase();
  if (TRANSITION_MAP[upper]) return upper;
  return status;
}

export class ReturnStateError extends Error {
  constructor(from, to) {
    super(`Illegal state transition: ${from} → ${to}`);
    this.name = 'ReturnStateError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Validate a proposed state transition.
 * Throws ReturnStateError on illegal move.
 * @param {string} from - current state
 * @param {string} to   - proposed next state
 */
export function assertTransition(from, to) {
  const allowed = TRANSITION_MAP[from];
  if (!allowed) {
    throw new ReturnStateError(from, to);
  }
  if (!allowed.has(to)) {
    throw new ReturnStateError(from, to);
  }
}

/**
 * Returns whether a transition is legal without throwing.
 */
export function canTransition(from, to) {
  try {
    assertTransition(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns all legal next states from the current state.
 */
export function allowedTransitions(from) {
  return Array.from(TRANSITION_MAP[from] || []);
}

/**
 * Whether a state is terminal (no further transitions possible).
 * The appeal exception (REJECTED → HUMAN_REVIEW) does not make REJECTED
 * non-terminal: REJECTED stays terminal for every other transition.
 */
export function isTerminal(state) {
  const allowed = TRANSITION_MAP[state];
  if (!allowed) return false;
  for (const to of allowed) {
    if (!isAppealTransition(state, to)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Action → to-state lookup used by transitionReturn().
// An action listed as null means "audit-only" — the state does not change.
// ---------------------------------------------------------------------------
const ACTION_MAP = {
  // Normal approvals / rejections
  APPROVE:           (from) => {
    // From NEEDS_INFO → skip straight to APPROVED via ELIGIBILITY_CHECK path allowed
    if (from === STATES.NEEDS_INFO || from === STATES.VERIFYING) return STATES.APPROVED;
    if (from === STATES.ELIGIBILITY_CHECK) return STATES.APPROVED;
    return STATES.APPROVED;
  },
  REJECT:            () => STATES.REJECTED,
  // Logistics progression
  SCHEDULE_PICKUP:   () => STATES.PICKUP_SCHEDULED,
  PICKUP_COMPLETE:   () => STATES.IN_TRANSIT,
  RECEIVE:           () => STATES.RECEIVED,
  INSPECT:           () => STATES.INSPECTION,
  // Refund outcomes
  REFUND_SUCCESS:    () => STATES.COMPLETED,
  REFUND_FAIL:       () => STATES.REFUND_FAILED,
  // Human escalation / appeal
  ESCALATE:          () => STATES.HUMAN_REVIEW,
  APPEAL:            () => STATES.HUMAN_REVIEW,
  // Audit-only — no state change
  REQUEST_EVIDENCE:  null,
};

/**
 * Build notification template per target state.
 * Text is built ONLY from fields of the return record.
 */
export function buildNotificationTemplate(targetState, record) {
  if (!record) return null;
  switch (targetState) {
    case STATES.APPROVED: {
      const itemOrRma = record.item?.name || record.rma_number || record.id || 'item';
      return {
        subject: 'Return Approved',
        body: `Your return request for ${itemOrRma} has been approved. Please prepare your item for pickup.`,
      };
    }
    case STATES.REJECTED: {
      const reasonCode = record.rejection_reason || record.rejection_code || record.reason_code || record.reason || 'POLICY_CRITERIA_NOT_MET';
      return {
        subject: 'Return Request Rejected',
        body: `Your return request was rejected. Reason code: ${reasonCode}. You may file an appeal through the return details page if you believe this is in error.`,
      };
    }
    case STATES.NEEDS_INFO: {
      const missing = record.missing_info || record.required_evidence || record.evidence_reason || record.missing_reason || 'Photo evidence or defect details';
      return {
        subject: 'Additional Information Needed',
        body: `Additional information is required for your return: ${missing}. Please upload the requested details to resume your return request.`,
      };
    }
    case STATES.PICKUP_SCHEDULED: {
      const slot = record.pickup_details?.slot || record.pickup_slot || record.pickup_slot_id || 'Scheduled pickup slot';
      return {
        subject: 'Return Pickup Scheduled',
        body: `Your return pickup has been scheduled for slot: ${slot}. Please keep the package packed securely.`,
      };
    }
    case STATES.IN_TRANSIT: {
      const tracking = record.carrier_tracking || record.tracking_number || record.pickup_details?.tracking_number || 'N/A';
      return {
        subject: 'Return In Transit',
        body: `Your return package has been picked up and is in transit to our warehouse. Tracking number: ${tracking}.`,
      };
    }
    case STATES.RECEIVED: {
      return {
        subject: 'Return Received at Warehouse',
        body: `Your return package has been received at the warehouse and is awaiting quality inspection.`,
      };
    }
    case STATES.REFUND_PROCESSING: {
      const amount = record.refund_amount ?? record.item?.price ?? 0;
      return {
        subject: 'Refund Processing',
        body: `Inspection complete. Your refund of ₹${amount} is currently being processed.`,
      };
    }
    case STATES.COMPLETED: {
      const amount = record.refund_amount ?? record.item?.price ?? 0;
      return {
        subject: 'Return Completed',
        body: `Your return is complete! A refund of ₹${amount} has been issued successfully.`,
      };
    }
    case STATES.HUMAN_REVIEW: {
      const reason = record.escalation_reason || record.appealReason || record.appeal_reason || record.reason || 'Manual review required';
      return {
        subject: 'Case Under Human Review',
        body: `Your return case has been routed to our support team for human review. Reason: ${reason}. We will update you within 24 hours.`,
      };
    }
    case STATES.CLOSED_STALE: {
      const identifier = record.rma_number || record.id || 'N/A';
      return {
        subject: 'Return Request Closed',
        body: `Your return request (${identifier}) has been closed due to inactivity because we did not receive a response within 7 days. If you still need help, please open a new request.`,
      };
    }
    default:
      return null;
  }
}

/**
 * Perform a state transition driven by a semantic action name or target state.
 * Includes notification hook for every transition with replay guard.
 *
 * @param {Object}  params
 * @param {Object}  [params.returnDoc]   - The current return document
 * @param {string}  [params.action]      - Semantic action (see ACTION_MAP above)
 * @param {string}  [params.toState]     - Explicit target state (overrides action mapping)
 * @param {string}  [params.actor]       - Who is performing the action
 * @param {Object}  [params.data]        - Extra payload stored in the audit event
 * @param {string}  [params.returnId]    - Return case ID
 * @param {string}  [params.previousHash]- Hash of the previous audit event
 * @param {Object}  [params.db]          - Firestore database reference (optional)
 * @param {boolean} [params.save]        - Whether to persist to store (default: true)
 * @returns {Promise<{ updatedDoc: Object, auditEvent: Object, notification: Object|null }>}
 */
export async function transitionReturn({
  returnDoc,
  action,
  toState,
  actor = 'system',
  data = {},
  returnId,
  previousHash,
  db = null,
  save = true,
}) {
  const id = returnId || returnDoc?.id || returnDoc?.returnId;
  let doc = returnDoc;
  if (!doc && id) {
    doc = await returnStore.getReturn({ db, identifier: id });
  }
  if (!doc) {
    throw new Error(`transitionReturn: return document not found for identifier "${id}"`);
  }

  const fromState = doc.status;

  // Determine target state
  let nextState;
  if (toState) {
    nextState = toState;
  } else {
    const resolver = ACTION_MAP[action];
    if (resolver === undefined) {
      throw new Error(`transitionReturn: unknown action "${action}". Add it to ACTION_MAP.`);
    }
    if (resolver === null) {
      // Audit-only action: state stays the same
      nextState = fromState;
    } else {
      nextState = resolver(fromState);
    }
  }

  // Validate (skip when state stays the same for audit-only events)
  if (nextState !== fromState) {
    assertTransition(fromState, nextState);
  }

  // Resolve previous hash
  let prevHash = previousHash;
  if (!prevHash && id) {
    prevHash = await returnStore.getLatestEventHash({ db, returnId: id });
  }
  if (!prevHash) prevHash = GENESIS_HASH;

  const auditEvent = createEvent({
    returnId: id,
    previousHash: prevHash,
    actor,
    action: action || `TRANSITION_${nextState}`,
    data: { fromState, toState: nextState, ...data },
  });

  const STATUS_LABELS = {
    [STATES.REQUESTED]:           'Return Requested',
    [STATES.VERIFYING]:           'Verifying',
    [STATES.ELIGIBILITY_CHECK]:   'Checking Eligibility',
    [STATES.APPROVED]:            'RMA Approved',
    [STATES.PICKUP_SCHEDULED]:    'Pickup Scheduled',
    [STATES.IN_TRANSIT]:          'In Transit',
    [STATES.RECEIVED]:            'Received at Warehouse',
    [STATES.INSPECTION]:          'Under Inspection',
    [STATES.REFUND_PROCESSING]:   'Refund Processing',
    [STATES.COMPLETED]:           'Refund Completed',
    [STATES.REJECTED]:            'Rejected',
    [STATES.HUMAN_REVIEW]:        'Needs Human Review',
    [STATES.NEEDS_INFO]:          'Needs Information',
    [STATES.CLOSED_STALE]:        'Closed (Stale)',
    [STATES.REFUND_FAILED]:       'Refund Failed',
    [STATES.REPLACEMENT_SHIPPED]: 'Replacement Shipped',
  };

  let updatedDoc = {
    ...doc,
    status:          nextState,
    status_label:    data.status_label || doc.status_label && doc.status === nextState ? doc.status_label : (STATUS_LABELS[nextState] || nextState),
    last_updated_at: auditEvent.timestamp,
    last_action:     action || `TRANSITION_${nextState}`,
    last_actor:      actor,
  };

  // Merge any extra data fields that callers commonly set on the doc
  if (data.rma)             updatedDoc.rma_number      = data.rma;
  if (data.resolution)      updatedDoc.resolution      = data.resolution;
  if (data.slotId)          updatedDoc.pickup_slot_id  = data.slotId;
  if (data.trackingNumber)  updatedDoc.tracking_number = data.trackingNumber;
  if (data.refundId)        updatedDoc.refund_id        = data.refundId;
  if (data.reason && nextState === STATES.REJECTED) updatedDoc.rejection_reason = data.reason;
  if (data.reason && nextState === STATES.HUMAN_REVIEW) updatedDoc.escalation_reason = data.reason;
  if (data.missing_info && nextState === STATES.NEEDS_INFO) updatedDoc.missing_info = data.missing_info;

  if (save) {
    updatedDoc = await returnStore.saveReturn({ db, returnRecord: updatedDoc, event: auditEvent });
  }

  // Notification hook: one message per transition, none on replay
  let notification = null;
  const notifiedStates = Array.isArray(updatedDoc.notified_states) ? updatedDoc.notified_states : [];
  const isReplay = fromState === nextState || notifiedStates.includes(nextState);

  if (!isReplay && nextState !== fromState) {
    const template = buildNotificationTemplate(nextState, updatedDoc);
    if (template) {
      try {
        notification = await notify({
          db,
          returnId: id,
          toUserId: updatedDoc.userId || updatedDoc.user_id,
          toEmail: updatedDoc.customerEmail || updatedDoc.email || '',
          subject: template.subject,
          body: template.body,
          sender: 'system',
        });
        updatedDoc.notified_states = [...notifiedStates, nextState];
        if (save) {
          await returnStore.saveReturn({ db, returnRecord: updatedDoc });
        }
      } catch (notifyErr) {
        // A notify failure never blocks a transition
        console.warn(`[transitionReturn] notify failed for return ${id}:`, notifyErr.message);
      }
    }
  }

  return { updatedDoc, auditEvent, notification };
}


