/**
 * Return State Machine — PS-01
 * Defines legal transitions; illegal jumps throw ReturnStateError.
 * No LLM dependency. Pure deterministic logic.
 */

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
  [STATES.NEEDS_INFO]:          new Set([STATES.VERIFYING, STATES.ELIGIBILITY_CHECK, STATES.HUMAN_REVIEW, STATES.CLOSED_STALE]),
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
