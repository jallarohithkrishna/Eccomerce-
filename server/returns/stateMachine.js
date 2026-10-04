/**
 * Return State Machine — PS-01
 * Defines legal transitions; illegal jumps throw ReturnStateError.
 * No LLM dependency. Pure deterministic logic.
 */

export const STATES = Object.freeze({
  REQUESTED:        'REQUESTED',
  VERIFYING:        'VERIFYING',
  ELIGIBILITY_CHECK:'ELIGIBILITY_CHECK',
  APPROVED:         'APPROVED',
  PICKUP_SCHEDULED: 'PICKUP_SCHEDULED',
  IN_TRANSIT:       'IN_TRANSIT',
  RECEIVED:         'RECEIVED',
  INSPECTION:       'INSPECTION',
  REFUND_PROCESSING:'REFUND_PROCESSING',
  COMPLETED:        'COMPLETED',
  HUMAN_REVIEW:     'HUMAN_REVIEW',
  REJECTED:         'REJECTED',
});

/**
 * Legal transitions: from → Set of allowed 'to' states
 */
const TRANSITION_MAP = {
  [STATES.REQUESTED]:         new Set([STATES.VERIFYING, STATES.HUMAN_REVIEW, STATES.REJECTED]),
  [STATES.VERIFYING]:         new Set([STATES.ELIGIBILITY_CHECK, STATES.HUMAN_REVIEW, STATES.REJECTED]),
  [STATES.ELIGIBILITY_CHECK]: new Set([STATES.APPROVED, STATES.HUMAN_REVIEW, STATES.REJECTED]),
  [STATES.APPROVED]:          new Set([STATES.PICKUP_SCHEDULED, STATES.HUMAN_REVIEW]),
  [STATES.PICKUP_SCHEDULED]:  new Set([STATES.IN_TRANSIT, STATES.HUMAN_REVIEW]),
  [STATES.IN_TRANSIT]:        new Set([STATES.RECEIVED, STATES.HUMAN_REVIEW]),
  [STATES.RECEIVED]:          new Set([STATES.INSPECTION, STATES.HUMAN_REVIEW]),
  [STATES.INSPECTION]:        new Set([STATES.REFUND_PROCESSING, STATES.HUMAN_REVIEW, STATES.REJECTED]),
  [STATES.REFUND_PROCESSING]: new Set([STATES.COMPLETED, STATES.HUMAN_REVIEW]),
  [STATES.COMPLETED]:         new Set(), // terminal
  [STATES.REJECTED]:          new Set(), // terminal
  // HUMAN_REVIEW can transition back to any non-terminal state (manual override)
  [STATES.HUMAN_REVIEW]:      new Set([
    STATES.ELIGIBILITY_CHECK,
    STATES.APPROVED,
    STATES.PICKUP_SCHEDULED,
    STATES.REFUND_PROCESSING,
    STATES.REJECTED,
    STATES.COMPLETED,
  ]),
};

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
 */
export function isTerminal(state) {
  const allowed = TRANSITION_MAP[state];
  return allowed ? allowed.size === 0 : false;
}
