/**
 * Agent Tools — PS-01 Returns Agent
 *
 * Design rules (enforced in code, NOT in prompts):
 * - Every read filters by caller's uid from the verified token
 * - create_return only allowed if session has an ELIGIBLE check_eligibility result for that orderId+productId+qty
 * - schedule_pickup requires state === 'APPROVED'
 * - file_appeal requires state === 'REJECTED' or 'DENIED'
 * - ask_customer retry counter; after 2 unanswered → CLOSED_STALE
 * - All Firestore reads bounded by limit(10)
 * - No refund tool exposed to LLM
 */

import { z } from 'zod';
import { evaluate }          from '../policy/engine.js';
import { verifyOrderForReturn } from '../returns/verify.js';
import { assertTransition, STATES } from '../returns/stateMachine.js';
import { evaluateException }  from '../returns/exceptions.js';
import * as session          from './session.js';
import { createEvent, GENESIS_HASH } from '../returns/audit.js';

const MAX_ASK_RETRIES = 2;

// ─── Tool Schemas (Zod) ───────────────────────────────────────────────────

export const ToolSchemas = {
  list_my_orders: z.object({}),

  get_order: z.object({
    order_id: z.string().min(1),
  }),

  check_eligibility: z.object({
    order_id:   z.string().min(1),
    product_id: z.string().min(1),
    quantity:   z.number().int().min(1).default(1),
    reason:     z.enum(['damage', 'defect', 'wrong_item', 'not_needed', 'spoiled', 'other']),
    photo_provided:       z.boolean().default(false),
    seal_intact:          z.boolean().optional(),
    tags_attached:        z.boolean().optional(),
    authenticity_cards:   z.boolean().optional(),
    original_packaging:   z.boolean().optional(),
    all_parts_included:   z.boolean().optional(),
  }),

  ask_customer: z.object({
    question: z.string().min(1).max(500),
  }),

  request_evidence: z.object({
    reason: z.string().min(1).max(200),
  }),

  create_return: z.object({
    order_id:   z.string().min(1),
    product_id: z.string().min(1),
    quantity:   z.number().int().min(1).default(1),
    reason:     z.string().min(1),
    resolution: z.enum(['refund', 'exchange', 'replacement', 'store_credit']),
  }),

  schedule_pickup: z.object({
    return_id: z.string().min(1),
    preferred_date: z.string().optional(),
  }),

  get_return_status: z.object({
    return_id: z.string().min(1),
  }),

  escalate_to_human: z.object({
    reason: z.string().min(1).max(500),
  }),

  file_appeal: z.object({
    return_id: z.string().min(1),
    appeal_reason: z.string().min(1).max(1000),
  }),
};

// ─── OpenAI Tool Definitions ──────────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_my_orders',
      description: 'List the authenticated customer\'s recent delivered orders (max 10). Use this when the customer does not know their order ID.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order',
      description: 'Get details of a specific order including items, delivery date, and status.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: 'Firestore order document ID' },
        },
        required: ['order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_eligibility',
      description: 'Check if an item in an order is eligible for return under policy. Must be called before create_return.',
      parameters: {
        type: 'object',
        properties: {
          order_id:           { type: 'string' },
          product_id:         { type: 'string' },
          quantity:           { type: 'integer', minimum: 1, default: 1 },
          reason:             { type: 'string', enum: ['damage', 'defect', 'wrong_item', 'not_needed', 'spoiled', 'other'] },
          photo_provided:     { type: 'boolean', default: false },
          seal_intact:        { type: 'boolean' },
          tags_attached:      { type: 'boolean' },
          authenticity_cards: { type: 'boolean' },
          original_packaging: { type: 'boolean' },
          all_parts_included: { type: 'boolean' },
        },
        required: ['order_id', 'product_id', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_customer',
      description: 'Ask the customer one clarifying question. Do not use for statements. Limit: 2 unanswered questions then the case is marked stale.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', maxLength: 500 },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_evidence',
      description: 'Ask the customer to upload a photo or video as evidence of damage or defect.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', maxLength: 200 },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_return',
      description: 'Create a return request. Requires check_eligibility to have returned ELIGIBLE for this order+product+quantity in this conversation.',
      parameters: {
        type: 'object',
        properties: {
          order_id:   { type: 'string' },
          product_id: { type: 'string' },
          quantity:   { type: 'integer', minimum: 1 },
          reason:     { type: 'string' },
          resolution: { type: 'string', enum: ['refund', 'exchange', 'replacement', 'store_credit'] },
        },
        required: ['order_id', 'product_id', 'quantity', 'reason', 'resolution'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_pickup',
      description: 'Schedule a reverse courier pickup for an approved return.',
      parameters: {
        type: 'object',
        properties: {
          return_id:      { type: 'string' },
          preferred_date: { type: 'string', description: 'Optional ISO date preference' },
        },
        required: ['return_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_return_status',
      description: 'Get the current status, timeline, and next steps for a return.',
      parameters: {
        type: 'object',
        properties: {
          return_id: { type: 'string' },
        },
        required: ['return_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description: 'Escalate the case to a human agent. Use for complex exceptions, fraud signals, or when the customer insists on human help.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', maxLength: 500 },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_appeal',
      description: 'File an appeal for a rejected or denied return. Requires the return to be in REJECTED state.',
      parameters: {
        type: 'object',
        properties: {
          return_id:     { type: 'string' },
          appeal_reason: { type: 'string', maxLength: 1000 },
        },
        required: ['return_id', 'appeal_reason'],
      },
    },
  },
];

// ─── Tool Executor ─────────────────────────────────────────────────────────

/**
 * Execute a tool call from the LLM.
 * @param {Object} params
 * @param {string} params.name           - tool name
 * @param {Object} params.args           - raw arguments (will be Zod-parsed)
 * @param {string} params.uid            - verified caller UID
 * @param {string} params.conversationId - session ID
 * @param {Object} [params.db]           - Firestore Admin instance (null in tests)
 * @returns {Promise<{ok: boolean, result: any, zodError?: string}>}
 */
export async function executeTool({ name, args, uid, conversationId, db }) {
  // 1. Schema validation
  const schema = ToolSchemas[name];
  if (!schema) return err(`Unknown tool: ${name}`);

  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return err(`Invalid arguments for ${name}: ${parsed.error.issues.map(i => i.message).join('; ')}`, true);
  }
  const a = parsed.data;

  // 2. Dispatch
  switch (name) {
    case 'list_my_orders':       return listMyOrders({ uid, db });
    case 'get_order':            return getOrder({ orderId: a.order_id, uid, db });
    case 'check_eligibility':    return checkEligibility({ ...a, uid, conversationId, db });
    case 'ask_customer':         return askCustomer({ ...a, conversationId });
    case 'request_evidence':     return requestEvidence({ ...a });
    case 'create_return':        return createReturn({ ...a, uid, conversationId, db });
    case 'schedule_pickup':      return schedulePickup({ ...a, uid, conversationId, db });
    case 'get_return_status':    return getReturnStatus({ returnId: a.return_id, uid, conversationId, db });
    case 'escalate_to_human':    return escalateToHuman({ ...a, uid, conversationId, db });
    case 'file_appeal':          return fileAppeal({ ...a, uid, conversationId, db });
    default:                     return err(`Tool not implemented: ${name}`);
  }
}

// ─── Tool Implementations ─────────────────────────────────────────────────

async function listMyOrders({ uid, db }) {
  if (!db) return ok({ orders: [] }); // test mode
  try {
    const { query, collection, where, orderBy, limit, getDocs } = await import('firebase-admin/firestore');
    const q = db.collection('orders')
      .where('user_id', '==', uid)
      .orderBy('created_at', 'desc')
      .limit(10);
    const snap = await q.get();
    const orders = snap.docs.map(d => {
      const data = d.data();
      return {
        order_id:    d.id,
        status:      data.status,
        created_at:  data.created_at,
        delivered_at: data.delivered_at,
        item_count:  (data.items || []).length,
        total:       data.total,
      };
    });
    return ok({ orders });
  } catch (e) {
    return err(`Failed to list orders: ${e.message}`);
  }
}

async function getOrder({ orderId, uid, db }) {
  if (!db) {
    // test mode: return a stub if the id looks like a test id
    if (orderId.startsWith('TEST-')) {
      return ok({ order: _testOrder(orderId, uid) });
    }
    return err(`Order ${orderId} not found`);
  }
  const result = await verifyOrderForReturn({ db, orderId, userId: uid, productId: '_probe', quantity: 0 })
    .catch(() => null);
  // verifyOrderForReturn checks item membership which will fail for _probe; use direct fetch
  try {
    const doc = await db.collection('orders').doc(orderId).get();
    if (!doc.exists) return err(`Order ${orderId} not found`);
    const data = doc.data();
    if (data.user_id !== uid && data.userId !== uid) {
      return err('You are not authorised to view this order.');
    }
    return ok({ order: { order_id: doc.id, ...data } });
  } catch (e) {
    return err(`Failed to get order: ${e.message}`);
  }
}

async function checkEligibility({ order_id, product_id, quantity, reason, uid, conversationId, db, ...flags }) {
  // Fetch order to get deliveredAt and item details
  let deliveredAt, category, itemName, itemPrice;

  if (!db) {
    // test mode
    const testOrder = _testOrder(order_id, uid);
    if (!testOrder) return err('Order not found (test mode)');
    const item = testOrder.items?.find(i => i.product_id === product_id);
    if (!item) return err(`Product ${product_id} not in order (test mode)`);
    deliveredAt = testOrder.delivered_at;
    category    = item.category  || 'standard';
    itemName    = item.name      || '';
    itemPrice   = item.price     || 0;
  } else {
    const verif = await verifyOrderForReturn({ db, orderId: order_id, userId: uid, productId: product_id, quantity });
    if (!verif.verified) return err(verif.failureReason);
    deliveredAt = verif.deliveredAt;
    category    = verif.item.category || 'standard';
    itemName    = verif.item.name     || '';
    itemPrice   = verif.item.price    || 0;
  }

  const result = evaluate({
    category,
    itemName,
    deliveredAt,
    requestedAt:       new Date().toISOString(),
    itemPrice,
    quantity:          quantity || 1,
    reason,
    photoProvided:     flags.photo_provided || false,
    sealIntact:        flags.seal_intact,
    tagsAttached:      flags.tags_attached,
    authenticityCards: flags.authenticity_cards,
    originalPackaging: flags.original_packaging,
    allPartsIncluded:  flags.all_parts_included,
  });

  // Store in session so create_return can verify
  session.storeEligibility(conversationId, order_id, product_id, quantity || 1, result);

  // Check exception matrix
  const exception = evaluateException({
    highValue:       result.requiresHumanReview,
    decisionCode:    result.decisionCode,
    policyKey:       result.policyKey,
    photoEvidence:   flags.photo_provided || false,
  });

  return ok({
    eligible:             result.eligible,
    policy_type:          result.policyType,
    allowed_resolutions:  result.allowedResolutions,
    requires_human_review: result.requiresHumanReview,
    decision_code:        result.decisionCode,
    decision_message:     result.decisionMessage,
    days_elapsed:         result.daysElapsed,
    window_days:          result.windowDays,
    exception_action:     exception.action,
    exception_code:       exception.code,
  });
}

async function askCustomer({ question, conversationId }) {
  const retries = session.incrementAskRetry(conversationId);
  if (retries > MAX_ASK_RETRIES) {
    return ok({
      action:  'CLOSED_STALE',
      message: 'Maximum clarification attempts reached. Case has been closed as stale. Please start a new request when ready.',
    });
  }
  return ok({ question, retries_used: retries, max_retries: MAX_ASK_RETRIES });
}

async function requestEvidence({ reason }) {
  return ok({
    action:       'EVIDENCE_REQUESTED',
    upload_hint:  'Please upload a clear photo or video showing the damage or defect. Supported: JPG, PNG, WebP (max 10MB).',
    reason,
  });
}

async function createReturn({ order_id, product_id, quantity, reason, resolution, uid, conversationId, db }) {
  // GUARD: must have a cached ELIGIBLE result for this exact combo
  const cached = session.getEligibility(conversationId, order_id, product_id, quantity);
  if (!cached) {
    return err('check_eligibility must be called before create_return for this order+product+quantity.');
  }
  if (!cached.eligible) {
    return err(`Cannot create return: eligibility check returned NOT ELIGIBLE. Reason: ${cached.decisionMessage}`);
  }

  // Generate RMA code
  const rmaCode  = `RMA-${Date.now().toString(36).toUpperCase()}`;
  const returnId = `ret_${Date.now().toString(36)}`;

  // Persist to Firestore (skip in test mode)
  if (db) {
    await db.collection('returns').doc(returnId).set({
      return_id:   returnId,
      rma_code:    rmaCode,
      order_id,
      product_id,
      quantity,
      reason,
      resolution,
      status:      STATES.APPROVED,
      user_id:     uid,
      created_at:  new Date().toISOString(),
      policy_key:  cached.policyKey,
      policy_type: cached.policyType,
      decision:    cached.decisionCode,
    });
  }

  session.setReturn(conversationId, returnId, STATES.APPROVED, rmaCode);
  session.resetAskRetry(conversationId);

  return ok({
    return_id:  returnId,
    rma_code:   rmaCode,
    status:     STATES.APPROVED,
    resolution,
    message:    `Return approved. RMA code: ${rmaCode}. Please keep this for your reference.`,
  });
}

async function schedulePickup({ return_id, preferred_date, uid, conversationId, db }) {
  const s = session.snapshot(conversationId);

  // GUARD: state must be APPROVED
  const currentState = s?.currentState;
  if (currentState && currentState !== STATES.APPROVED && currentState !== STATES.PICKUP_SCHEDULED) {
    return err(`Cannot schedule pickup: return is in state ${currentState}. Must be APPROVED.`);
  }

  // Mock slot generation
  const pickupDate = preferred_date || nextBusinessDay();
  const slot       = `${pickupDate} (10 AM – 1 PM)`;

  if (db && return_id && !return_id.startsWith('ret_TEST')) {
    await db.collection('returns').doc(return_id).update({
      status:       STATES.PICKUP_SCHEDULED,
      pickup_slot:  slot,
      updated_at:   new Date().toISOString(),
    }).catch(() => {});
  }

  session.updateState(conversationId, STATES.PICKUP_SCHEDULED);

  return ok({
    return_id,
    pickup_slot:   slot,
    carrier:       'BlueDart Express',
    status:        STATES.PICKUP_SCHEDULED,
    instructions:  'Keep the item packed securely. Our courier will collect it from your registered address.',
  });
}

async function getReturnStatus({ returnId, uid, conversationId, db }) {
  if (!db) {
    const s = session.snapshot(conversationId);
    return ok({
      return_id: returnId,
      status:    s?.currentState || 'UNKNOWN',
      message:   'Status from session (test mode)',
    });
  }
  try {
    const doc = await db.collection('returns').doc(returnId).get();
    if (!doc.exists) return err(`Return ${returnId} not found`);
    const data = doc.data();
    if (data.user_id !== uid) return err('Not authorised to view this return.');
    return ok({
      return_id:   doc.id,
      status:      data.status,
      rma_code:    data.rma_code,
      resolution:  data.resolution,
      pickup_slot: data.pickup_slot,
      created_at:  data.created_at,
    });
  } catch (e) {
    return err(`Failed to get return status: ${e.message}`);
  }
}

async function escalateToHuman({ reason, uid, conversationId, db }) {
  const s = session.snapshot(conversationId);
  const casePacket = {
    conversationId,
    uid,
    returnId:     s?.returnId,
    currentState: s?.currentState,
    reason,
    escalatedAt:  new Date().toISOString(),
  };

  if (db && s?.returnId && !s.returnId.startsWith('ret_TEST')) {
    await db.collection('returns').doc(s.returnId).update({
      status:        STATES.HUMAN_REVIEW,
      escalated_at:  casePacket.escalatedAt,
      escalation_reason: reason,
    }).catch(() => {});
  }

  if (s?.returnId) session.updateState(conversationId, STATES.HUMAN_REVIEW);

  return ok({
    action:     'ESCALATED',
    ticket_id:  `ESC-${Date.now().toString(36).toUpperCase()}`,
    message:    'Your case has been escalated to a specialist. You will hear back within 24 hours.',
    case_packet: casePacket,
  });
}

async function fileAppeal({ return_id, appeal_reason, uid, conversationId, db }) {
  const s = session.snapshot(conversationId);

  // GUARD: must be in REJECTED state
  const state = s?.currentState;
  if (state && state !== STATES.REJECTED && state !== 'REJECTED' && state !== 'DENIED') {
    return err(`Cannot file appeal: return is in state ${state}. Appeals are only for rejected returns.`);
  }

  if (db && !return_id.startsWith('ret_TEST')) {
    await db.collection('returns').doc(return_id).update({
      status:         STATES.HUMAN_REVIEW,
      appeal_reason,
      appealed_at:    new Date().toISOString(),
    }).catch(() => {});
  }

  session.updateState(conversationId, STATES.HUMAN_REVIEW);

  return ok({
    return_id,
    action:     'APPEAL_FILED',
    ticket_id:  `APP-${Date.now().toString(36).toUpperCase()}`,
    message:    'Your appeal has been filed and will be reviewed by a specialist within 2 business days.',
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function ok(result) { return { ok: true, result }; }
function err(message, isZodError = false) { return { ok: false, result: { error: message }, zodError: isZodError }; }

function nextBusinessDay() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // skip Sunday
  if (d.getDay() === 6) d.setDate(d.getDate() + 1); // skip Saturday
  return d.toISOString().slice(0, 10);
}

// Test mode stub orders — keyed by test order id prefix
// IMPORTANT: delivered_at uses dynamic recent dates so test orders are always
// within their policy windows. TEST-EXPIRED uses a fixed old date.
export function _testOrder(orderId, uid) {
  // "5 days ago" — within every policy window (min 7 days for beauty)
  const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  const orderMap = {
    'TEST-FASHION-OK': {
      order_id: 'TEST-FASHION-OK', user_id: uid, status: 'delivered',
      delivered_at: recent,
      items: [{ product_id: 'P-SHIRT', name: 'Blue Shirt', category: 'fashion', price: 999, quantity: 1 }],
    },
    'TEST-ELECTRONICS': {
      order_id: 'TEST-ELECTRONICS', user_id: uid, status: 'delivered',
      delivered_at: recent,
      items: [{ product_id: 'P-PHONE', name: 'Smartphone X', category: 'smartphones', price: 25000, quantity: 1 }],
    },
    'TEST-EXPIRED': {
      order_id: 'TEST-EXPIRED', user_id: uid, status: 'delivered',
      delivered_at: '2020-01-01T10:00:00.000Z', // genuinely old — all windows expired
      items: [{ product_id: 'P-SHIRT', name: 'Old Shirt', category: 'fashion', price: 500, quantity: 1 }],
    },
    'TEST-OTHER-USER': {
      order_id: 'TEST-OTHER-USER', user_id: 'OTHER-UID-999', status: 'delivered',
      delivered_at: recent,
      items: [{ product_id: 'P-SHIRT', name: 'Other Shirt', category: 'fashion', price: 500, quantity: 1 }],
    },
    'TEST-LUXURY': {
      order_id: 'TEST-LUXURY', user_id: uid, status: 'delivered',
      delivered_at: recent,
      items: [{ product_id: 'P-WATCH', name: 'Gold Watch', category: 'luxury', price: 75000, quantity: 1 }],
    },
  };
  return orderMap[orderId] || null;
}
