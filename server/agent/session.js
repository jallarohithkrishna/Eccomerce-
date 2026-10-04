/**
 * Session Store — PS-01 Agent
 * In-memory (fast) + optional Firestore sync (durable).
 * Each session is keyed by conversationId.
 * Messages are capped at last 10 turns (20 entries). Tool summaries replace full results.
 */

const MAX_TURNS     = 10;  // keep last N user+assistant turn pairs
const MAX_MESSAGES  = MAX_TURNS * 2;

/** @type {Map<string, Session>} */
const store = new Map();

/**
 * @typedef {Object} Session
 * @property {string}   conversationId
 * @property {string}   uid               - verified user UID
 * @property {Array}    messages          - chat history (capped)
 * @property {Map}      eligibilityCache  - key: `${orderId}:${productId}:${qty}` → EligibilityResult
 * @property {number}   askRetries        - unanswered ask_customer calls
 * @property {string}   [returnId]        - set after create_return
 * @property {string}   [currentState]    - last known return state
 * @property {number}   createdAt
 * @property {number}   updatedAt
 */

/**
 * Get or create a session.
 * @param {string} conversationId
 * @param {string} uid
 * @returns {Session}
 */
export function getOrCreate(conversationId, uid) {
  if (store.has(conversationId)) {
    const s = store.get(conversationId);
    if (s.uid !== uid) throw new Error('Session UID mismatch — possible hijack attempt');
    return s;
  }
  const session = {
    conversationId,
    uid,
    messages:         [],
    eligibilityCache: new Map(),
    askRetries:       0,
    returnId:         null,
    currentState:     null,
    createdAt:        Date.now(),
    updatedAt:        Date.now(),
  };
  store.set(conversationId, session);
  return session;
}

/**
 * Append a message to the session; trims to MAX_MESSAGES.
 */
export function appendMessage(conversationId, message) {
  const s = store.get(conversationId);
  if (!s) throw new Error(`Session ${conversationId} not found`);
  s.messages.push(message);
  if (s.messages.length > MAX_MESSAGES) {
    s.messages = s.messages.slice(-MAX_MESSAGES);
  }
  s.updatedAt = Date.now();
}

/**
 * Store the result of a check_eligibility call.
 * Key: `orderId:productId:qty`
 */
export function storeEligibility(conversationId, orderId, productId, qty, result) {
  const s = store.get(conversationId);
  if (!s) throw new Error(`Session ${conversationId} not found`);
  s.eligibilityCache.set(`${orderId}:${productId}:${qty}`, result);
  s.updatedAt = Date.now();
}

/**
 * Read the last eligibility result for a given orderId+productId+qty combination.
 * Returns null if not found.
 */
export function getEligibility(conversationId, orderId, productId, qty) {
  const s = store.get(conversationId);
  if (!s) return null;
  return s.eligibilityCache.get(`${orderId}:${productId}:${qty}`) || null;
}

/**
 * Increment the ask_customer retry counter. Returns new count.
 */
export function incrementAskRetry(conversationId) {
  const s = store.get(conversationId);
  if (!s) throw new Error(`Session ${conversationId} not found`);
  s.askRetries += 1;
  s.updatedAt = Date.now();
  return s.askRetries;
}

/**
 * Reset ask retry counter (after customer replies).
 */
export function resetAskRetry(conversationId) {
  const s = store.get(conversationId);
  if (s) { s.askRetries = 0; s.updatedAt = Date.now(); }
}

/**
 * Set the returnId and current state.
 */
export function setReturn(conversationId, returnId, state) {
  const s = store.get(conversationId);
  if (!s) throw new Error(`Session ${conversationId} not found`);
  s.returnId     = returnId;
  s.currentState = state;
  s.updatedAt    = Date.now();
}

/**
 * Update the current state.
 */
export function updateState(conversationId, state) {
  const s = store.get(conversationId);
  if (s) { s.currentState = state; s.updatedAt = Date.now(); }
}

/**
 * Get session snapshot (safe for audit — eligibilityCache as plain object).
 */
export function snapshot(conversationId) {
  const s = store.get(conversationId);
  if (!s) return null;
  return {
    conversationId: s.conversationId,
    uid:            s.uid,
    messageCount:   s.messages.length,
    askRetries:     s.askRetries,
    returnId:       s.returnId,
    currentState:   s.currentState,
    createdAt:      s.createdAt,
    updatedAt:      s.updatedAt,
  };
}

/** Delete a session (for tests / cleanup). */
export function destroy(conversationId) {
  store.delete(conversationId);
}

/** For tests: clear all sessions. */
export function _clearAll() {
  store.clear();
}
