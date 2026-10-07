/**
 * Express Returns API Router — PS-01 Phase 4
 *
 * Implements:
 * - POST /returns/intake
 * - GET  /returns/:id
 * - GET  /returns/verify/:identifier (public QR pass data)
 * - POST /returns/:id/messages
 * - GET  /returns/:id/messages
 * - POST /returns/:id/evidence
 * - POST /returns/:id/appeal
 * - GET  /agent/returns
 * - POST /agent/returns/:id/approve
 * - POST /agent/returns/:id/deny
 * - POST /agent/returns/:id/override
 * - POST /warehouse/returns/:id/receive
 * - POST /warehouse/returns/:id/inspect
 * - POST /webhooks/carrier
 * - GET  /returns/:id/audit
 */

import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import multer from 'multer';
import { verifyIdToken, requireRole } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { evaluate as evaluatePolicy } from '../policy/engine.js';
import { assertTransition, normalizeStatus, STATES } from '../returns/stateMachine.js';
import { createEvent, verifyChain, GENESIS_HASH } from '../returns/audit.js';
import { initiateRefund } from '../returns/refunds.js';
import { analyzeEvidence, detectMimeType, checkUploadRateLimit } from '../agent/evidence.js';
import * as returnStore from '../returns/store.js';
import { OrderStatusError } from '../returns/store.js';
import { RMA_PATTERN } from '../returns/rma.js';

/** Header the carrier must send the shared secret in. */
export const CARRIER_SECRET_HEADER = 'x-carrier-secret';

/** Fallback secret for local/dev/test runs. Never valid in production. */
const DEV_CARRIER_SECRET = 'dev-carrier-secret-CHANGE-IN-PROD';

/**
 * Resolve the active carrier webhook secret.
 * Production requires CARRIER_WEBHOOK_SECRET to be present in the environment
 * (enforced at router construction, see createReturnsRouter).
 */
export function carrierWebhookSecret(env = process.env) {
  if (env.CARRIER_WEBHOOK_SECRET) return env.CARRIER_WEBHOOK_SECRET;
  if (env.NODE_ENV === 'production') return null;
  return DEV_CARRIER_SECRET;
}

/**
 * Constant-time secret comparison. Both sides are hashed first so that the
 * compare is always over two 32-byte buffers (equal length, no length leak).
 */
export function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createReturnsRouter(db) {
  const router = express.Router();

  // Refuse to boot an unauthenticated carrier webhook into production.
  if (process.env.NODE_ENV === 'production' && !process.env.CARRIER_WEBHOOK_SECRET) {
    throw new Error(
      'CARRIER_WEBHOOK_SECRET must be set in production. Refusing to start the returns API without it.'
    );
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  // ── Helper to create and append an audit event ────────────────────────────
  async function logAudit({ returnId, actor, action, data }) {
    const prevHash = await returnStore.getLatestEventHash({ db, returnId });
    const events = await returnStore.getAuditEvents({ db, returnId });
    const seq = events.length + 1;
    const ev = createEvent({
      returnId,
      previousHash: prevHash || GENESIS_HASH,
      actor: actor || 'system',
      action,
      data: data || {},
    });
    ev.seq = seq;
    ev.prevHash = ev.previousHash;
    await returnStore.appendAuditEvent({ db, returnId, event: ev });
    return ev;
  }

  async function saveWithAudit({ returnRecord, actor, action, data }) {
    const returnId = returnRecord.id || returnRecord.returnId;
    const prevHash = await returnStore.getLatestEventHash({ db, returnId });
    const events = await returnStore.getAuditEvents({ db, returnId });
    const seq = events.length + 1;
    const ev = createEvent({
      returnId,
      previousHash: prevHash || GENESIS_HASH,
      actor: actor || 'system',
      action,
      data: data || {},
    });
    ev.seq = seq;
    ev.prevHash = ev.previousHash;
    const updated = await returnStore.saveReturn({ db, returnRecord, event: ev });
    return { updated, auditEvent: ev };
  }

  function shouldSync(db) {
    if (!db) return false;
    if (process.env.NODE_ENV === 'test' && !process.env.FIRESTORE_EMULATOR_HOST) return false;
    return true;
  }

  // ── 1. POST /returns/intake ──────────────────────────────────────────────
  const IntakeBodySchema = z.object({
    orderId:        z.string().min(1),
    productId:      z.string().optional().nullable(),
    reason:         z.string().min(1),
    quantity:       z.coerce.number().int().min(1).default(1),
    resolutionType: z.enum(['refund', 'exchange', 'store_credit']).default('refund'),
    notes:          z.string().optional(),
    photoProvided:  z.boolean().optional().default(false),
  });

  router.post('/returns/intake',
    verifyIdToken,
    rateLimit({ max: 20, windowMs: 60_000 }),
    async (req, res) => {
      const parsed = IntakeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid return request data', issues: parsed.error.issues });
      }

      const uid = req.user.uid;
      const { orderId, productId, reason, quantity, resolutionType, photoProvided } = parsed.data;

      try {
        // 1. Order lookup — find order from Firestore or store
        const order = await returnStore.getOrder({ db, orderId });
        if (!order) {
          return res.status(404).json({ error: 'Order not found' });
        }

        // 2. Ownership verification — caller must own the order unless admin/staff (404 to prevent enumeration)
        const ownerUid = order.customer?.user_id || order.user_id || order.userId;
        if (ownerUid && ownerUid !== uid && req.user.role !== 'admin' && req.user.role !== 'staff') {
          return res.status(404).json({ error: 'Order not found' });
        }

        // 3. Order status verification — must be delivered
        const orderStatus = (order.status || '').toLowerCase();
        if (orderStatus !== 'delivered' && !order.delivered_at && !order.deliveredAt) {
          return res.status(422).json({
            error: 'Order must be delivered before initiating a return',
            code: 'ORDER_NOT_DELIVERED'
          });
        }

        // Delivered timestamp — must exist to evaluate policy window (never fall back to 'now')
        const rawDeliveredAt = order.delivered_at || order.deliveredAt;
        if (!rawDeliveredAt) {
          return res.status(422).json({
            error: 'Order delivery date is missing; cannot evaluate return window',
            code: 'DELIVERY_DATE_MISSING'
          });
        }
        const deliveredAt = rawDeliveredAt.toDate
          ? rawDeliveredAt.toDate().toISOString()
          : (typeof rawDeliveredAt === 'string' ? rawDeliveredAt : new Date(rawDeliveredAt).toISOString());

        // 4. Product matching from order.items — no constant fallbacks
        if (!Array.isArray(order.items) || order.items.length === 0) {
          return res.status(400).json({ error: 'Order contains no items' });
        }

        let orderItem = null;
        if (productId) {
          orderItem = order.items.find(i => String(i.product_id || i.id) === String(productId));
          if (!orderItem) {
            return res.status(404).json({ error: `Product '${productId}' not found in order` });
          }
        } else if (order.items.length === 1) {
          orderItem = order.items[0];
        } else {
          return res.status(400).json({ error: 'productId is required when order contains multiple items' });
        }

        const itemPrice = Number(orderItem.price);
        if (isNaN(itemPrice) || itemPrice <= 0) {
          return res.status(400).json({ error: 'Order item has an invalid price' });
        }
        const itemName  = orderItem.name || 'Purchased Item';
        const category  = orderItem.category || 'standard';
        const orderedQty = Number(orderItem.quantity) || 1;

        // 5. Quantity limit check
        if (Number(quantity) > orderedQty) {
          return res.status(422).json({
            error: `Return quantity (${quantity}) exceeds ordered quantity (${orderedQty})`,
            code: 'EXCEEDS_ORDERED_QUANTITY',
            orderedQuantity: orderedQty
          });
        }

        // 6. Already returned check
        const targetProdId = String(orderItem.product_id || orderItem.id);
        let alreadyReturnedQty = 0;
        const countedReturnIds = new Set();

        if (Array.isArray(order.returns)) {
          for (const ret of order.returns) {
            const retId = ret.id || ret.returnId || ret.rma_number;
            if (retId && countedReturnIds.has(retId)) continue;
            if (retId) countedReturnIds.add(retId);

            const retProdId = String(ret.productId || ret.product_id || ret.item?.product_id || ret.item?.id || '');
            const retStatus = normalizeStatus(ret.status);
            if (retProdId === targetProdId && retStatus !== STATES.REJECTED) {
              alreadyReturnedQty += Number(ret.quantity || ret.item?.quantity || 1);
            }
          }
        }

        const existingReturns = await returnStore.getReturnsForOrder({ db, orderId });
        for (const ret of existingReturns) {
          const retId = ret.id || ret.returnId || ret.rma_number;
          if (retId && countedReturnIds.has(retId)) continue;
          if (retId) countedReturnIds.add(retId);

          const retProdId = String(ret.productId || ret.product_id || ret.item?.product_id || ret.item?.id || '');
          const retStatus = normalizeStatus(ret.status);
          if (retProdId === targetProdId && retStatus !== STATES.REJECTED) {
            alreadyReturnedQty += Number(ret.quantity || ret.item?.quantity || 1);
          }
        }

        const remainingReturnable = orderedQty - alreadyReturnedQty;
        if (remainingReturnable <= 0) {
          return res.status(422).json({
            error: `Item '${itemName}' has already been returned`,
            code: 'ALREADY_RETURNED',
            orderedQuantity: orderedQty,
            alreadyReturnedQuantity: alreadyReturnedQty
          });
        }

        if (Number(quantity) > remainingReturnable) {
          return res.status(422).json({
            error: `Requested return quantity (${quantity}) exceeds remaining returnable quantity (${remainingReturnable})`,
            code: 'EXCEEDS_RETURNABLE_QUANTITY',
            orderedQuantity: orderedQty,
            alreadyReturnedQuantity: alreadyReturnedQty,
            remainingReturnableQuantity: remainingReturnable
          });
        }

        // 7. Deterministic policy evaluation using actual delivered_at from order
        let eligibility = null;
        try {
          eligibility = evaluatePolicy({
            category,
            itemName,
            deliveredAt,
            requestedAt: new Date().toISOString(),
            itemPrice,
            quantity: Number(quantity),
            reason,
            photoProvided: Boolean(photoProvided),
          });
        } catch (err) {
          console.warn('Policy evaluation warning:', err.message);
        }

        if (eligibility && !eligibility.eligible && !eligibility.requiresHumanReview) {
          return res.status(422).json({
            error: 'Return not eligible under policy',
            reason: eligibility.decisionMessage,
            code: eligibility.decisionCode
          });
        }

        const baseRefund = itemPrice * Number(quantity);
        const refundAmount = resolutionType === 'store_credit' ? baseRefund * 1.05 : baseRefund;
        const status = eligibility?.requiresHumanReview ? STATES.HUMAN_REVIEW : STATES.REQUESTED;

        const returnId = `ret_${Date.now()}`;
        const rmaNumber = await returnStore.generateUniqueRma({ db });

        const returnRecord = {
          id: returnId,
          returnId,
          rma_number: rmaNumber,
          orderId,
          order_id: orderId,
          userId: uid,
          user_id: uid,
          productId: productId || orderItem.id,
          product_id: productId || orderItem.id,
          reason,
          quantity: Number(quantity),
          resolutionType,
          resolution_type: resolutionType,
          refund_amount: refundAmount,
          item: {
            name: itemName,
            price: itemPrice,
            quantity: Number(quantity),
            category,
            image_url: orderItem.image_url || orderItem.images?.[0] || null
          },
          pickup_details: {
            carrier: 'BlueDart Express Reverse',
            tracking_number: `RET-DEL-${Math.floor(10000000 + Math.random() * 90000000)}`,
            slot: 'Tomorrow, 10:00 AM - 1:00 PM',
            address: order?.customer?.address || 'Customer Registered Delivery Address'
          },
          status,
          status_label: status === STATES.HUMAN_REVIEW ? 'Needs Human Review' : 'Return Requested',
          eligibility_decision: eligibility?.decisionCode || 'SERVER_REVIEW',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const { updated: finalRecord } = await saveWithAudit({
          returnRecord,
          actor: uid,
          action: 'RETURN_REQUESTED',
          data: {
            orderId,
            reason,
            quantity,
            resolutionType,
            eligibility: eligibility?.decisionCode,
            status
          }
        });

        res.status(201).json({ success: true, returnRecord: finalRecord });
      } catch (err) {
        console.error('Intake error:', err);
        res.status(500).json({ error: 'Failed to process return intake', detail: err.message });
      }
    }
  );

  // ── 2. GET /returns/:id ──────────────────────────────────────────────────
  router.get('/returns/:id', verifyIdToken, async (req, res) => {
    const returnId = req.params.id;
    const uid = req.user.uid;
    const isStaffOrAdmin = req.user.role === 'staff' || req.user.role === 'admin' || req.user.role === 'warehouse';

    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) {
      return res.status(404).json({ error: 'Return case not found' });
    }

    const owner = record.userId || record.user_id;
    if (owner !== uid && !isStaffOrAdmin) {
      return res.status(403).json({ error: 'Access denied: not your return record' });
    }

    res.json(record);
  });

  // ── 3. GET /returns/verify/:identifier (Public QR courier pass route) ─────
  // Unguessable key + 30 req/min/IP. Only non-personal logistics fields leave
  // this endpoint: no uid, no address, no email/phone, no customer free text.
  router.get('/returns/verify/:identifier',
    rateLimit({ max: 30, windowMs: 60_000 }),
    async (req, res) => {
      const identifier = String(req.params.identifier || '').trim().toUpperCase();

      // Only well-formed RMA numbers address a case. Raw `ret_*` ids, order ids
      // and tracking numbers are rejected outright so nothing can be enumerated.
      if (!RMA_PATTERN.test(identifier)) {
        return res.status(404).json({ error: 'Return verification pass not found' });
      }

      const record = await returnStore.getReturn({ db, identifier });
      if (!record) {
        return res.status(404).json({ error: 'Return verification pass not found' });
      }

      // Whitelist — never spread the stored record.
      res.json({
        id:              record.id,
        rma_number:      record.rma_number,
        order_number:    record.order_id || record.orderId || 'N/A',
        status:          record.status,
        status_label:    record.status_label || record.status,
        item: record.item
          ? {
              name:      record.item.name,
              quantity:  record.item.quantity,
              price:     record.item.price,
              category:  record.item.category,
              image_url: record.item.image_url || null,
            }
          : { name: 'Item', quantity: record.quantity || 1, price: 0 },
        pickup_details: {
          carrier:         record.pickup_details?.carrier || 'Express Courier',
          tracking_number: record.pickup_details?.tracking_number || null,
          slot:            record.pickup_details?.slot || null,
        },
        resolution_type: record.resolutionType || record.resolution_type || 'refund',
        refund_amount:   record.refund_amount || 0,
        createdAt:       record.createdAt,
        timeline: record.timeline || [
          { stage: 'Return Requested', done: true },
          { stage: 'RMA Authorized', done: true },
          { stage: 'Pickup Scheduled', done: record.status !== STATES.REQUESTED },
          { stage: 'Warehouse Inspection', done: [STATES.RECEIVED, STATES.INSPECTION, STATES.COMPLETED].includes(record.status) },
          { stage: 'Refund Credited', done: record.status === STATES.COMPLETED },
        ],
      });
    }
  );

  // ── 4. POST & GET /returns/:id/messages ──────────────────────────────────
  const MessageBodySchema = z.object({
    message: z.string().min(1).max(2000),
  });

  router.post('/returns/:id/messages', verifyIdToken, async (req, res) => {
    const returnId = req.params.id;
    const uid = req.user.uid;
    const isStaffOrAdmin = req.user.role === 'staff' || req.user.role === 'admin';

    const parsed = MessageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid message', issues: parsed.error.issues });
    }

    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return case not found' });

    const owner = record.userId || record.user_id;
    if (owner !== uid && !isStaffOrAdmin) {
      return res.status(403).json({ error: 'Unauthorized to post messages on this return' });
    }

    const msg = await returnStore.appendReturnMessage({
      db,
      returnId: record.id,
      message: {
        sender: uid,
        senderRole: req.user.role || 'customer',
        text: parsed.data.message,
      }
    });

    await logAudit({
      returnId: record.id,
      actor: uid,
      action: 'MESSAGE_ADDED',
      data: { senderRole: req.user.role, messageId: msg.id }
    });

    res.status(201).json({ success: true, message: msg });
  });

  router.get('/returns/:id/messages', verifyIdToken, async (req, res) => {
    const returnId = req.params.id;
    const uid = req.user.uid;
    const isStaffOrAdmin = req.user.role === 'staff' || req.user.role === 'admin' || req.user.role === 'warehouse';

    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return case not found' });

    const owner = record.userId || record.user_id;
    if (owner !== uid && !isStaffOrAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view messages' });
    }

    const messages = await returnStore.getReturnMessages({ db, returnId: record.id });
    res.json({ returnId: record.id, messages });
  });

  // ── 5. POST /returns/:id/evidence ────────────────────────────────────────
  router.post('/returns/:id/evidence',
    verifyIdToken,
    upload.single('file'),
    async (req, res) => {
      const returnId = req.params.id;
      const uid = req.user.uid;
      const isStaffOrAdmin = req.user.role === 'staff' || req.user.role === 'admin';

      const record = await returnStore.getReturn({ db, identifier: returnId });
      if (!record) return res.status(404).json({ error: 'Return case not found' });

      const owner = record.userId || record.user_id;
      if (owner !== uid && !isStaffOrAdmin) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });

      const mimeType = detectMimeType(req.file.buffer);
      if (!mimeType) {
        return res.status(415).json({ error: 'Unsupported file type. Please upload a JPEG, PNG, or WebP image.' });
      }

      if (!checkUploadRateLimit(record.id)) {
        return res.status(429).json({ error: 'Upload rate limit exceeded (5/hour)' });
      }

      const analysisResult = await analyzeEvidence({ imageBuffer: req.file.buffer, mimeType });

      const { updated, auditEvent: ev } = await saveWithAudit({
        returnRecord: {
          ...record,
          id: record.id,
          photo_evidence_hash: analysisResult.hash,
          photo_verified: analysisResult.verified,
          photo_analysis: analysisResult.analysis,
        },
        actor: uid,
        action: 'EVIDENCE_UPLOADED',
        data: {
          hash: analysisResult.hash,
          mimeType,
          sizeBytes: analysisResult.sizeBytes,
          verified: analysisResult.verified,
        }
      });

      res.json({
        success: true,
        hash: analysisResult.hash,
        verified: analysisResult.verified,
        analysis: analysisResult.analysis,
        auditEvent: ev,
        returnRecord: updated,
      });
    }
  );

  // ── 6. POST /returns/:id/appeal ──────────────────────────────────────────
  const AppealBodySchema = z.object({
    reason: z.string().min(5).max(1000),
  });

  router.post('/returns/:id/appeal', verifyIdToken, async (req, res) => {
    const returnId = req.params.id;
    const uid = req.user.uid;
    const isStaffOrAdmin = req.user.role === 'staff' || req.user.role === 'admin';

    const parsed = AppealBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid appeal reason', issues: parsed.error.issues });
    }

    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return case not found' });

    const owner = record.userId || record.user_id;
    if (owner !== uid && !isStaffOrAdmin) {
      return res.status(403).json({ error: 'Unauthorized to file appeal' });
    }

    if (record.status !== STATES.REJECTED && record.status !== 'rejected') {
      return res.status(400).json({ error: `Cannot appeal return with status '${record.status}'. Only REJECTED returns can be appealed.` });
    }

    // The state machine is the authority: REJECTED → HUMAN_REVIEW is the one
    // legal edge out of REJECTED (the appeal exception). Anything else throws.
    try {
      assertTransition(normalizeStatus(record.status), STATES.HUMAN_REVIEW);
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }

    const { updated } = await saveWithAudit({
      returnRecord: {
        ...record,
        id: record.id,
        status: STATES.HUMAN_REVIEW,
        status_label: 'Needs Human Review (Appealed)',
        appealReason: parsed.data.reason,
        appealedAt: new Date().toISOString(),
      },
      actor: uid,
      action: 'APPEAL_FILED',
      data: { reason: parsed.data.reason, from: record.status, to: STATES.HUMAN_REVIEW }
    });

    res.json({ success: true, returnRecord: updated });
  });

  // ── 7. GET /agent/returns (Staff view queue) ─────────────────────────────
  router.get('/agent/returns', verifyIdToken, requireRole('staff', 'admin'), async (req, res) => {
    const status = req.query.status ? String(req.query.status).trim() : null;
    const limitN = req.query.limit ? Math.min(Number(req.query.limit) || 50, 100) : 50;

    const list = await returnStore.listReturns({ db, status, limitN });
    res.json({ returns: list });
  });

  // ── 8. POST /agent/returns/:id/approve ────────────────────────────────────
  router.post('/agent/returns/:id/approve', verifyIdToken, requireRole('staff', 'admin'), async (req, res) => {
    const returnId = req.params.id;
    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return case not found' });

    const current = normalizeStatus(record.status) || STATES.REQUESTED;

    // Already approved — idempotent, no write.
    if (current === STATES.APPROVED) {
      return res.json({ success: true, status: STATES.APPROVED, returnRecord: record });
    }

    try {
      assertTransition(current, STATES.APPROVED);
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }

    const { updated } = await saveWithAudit({
      returnRecord: {
        ...record,
        id: record.id,
        status: STATES.APPROVED,
        status_label: 'RMA Approved',
        approved_by: req.user.uid,
        approved_at: new Date().toISOString(),
      },
      actor: req.user.uid,
      action: 'STAFF_APPROVED',
      data: { from: current, to: STATES.APPROVED }
    });

    res.json({ success: true, status: STATES.APPROVED, returnRecord: updated });
  });

  // ── 9. POST /agent/returns/:id/deny ───────────────────────────────────────
  const DenyBodySchema = z.object({
    reason: z.string().optional().default('Does not meet return criteria'),
  });

  router.post('/agent/returns/:id/deny', verifyIdToken, requireRole('staff', 'admin'), async (req, res) => {
    const returnId = req.params.id;
    const parsed = DenyBodySchema.safeParse(req.body || {});
    const reason = parsed.success ? parsed.data.reason : 'Denied by staff';

    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return case not found' });

    const current = normalizeStatus(record.status) || STATES.REQUESTED;
    try {
      assertTransition(current, STATES.REJECTED);
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }

    const { updated } = await saveWithAudit({
      returnRecord: {
        ...record,
        id: record.id,
        status: STATES.REJECTED,
        status_label: 'Rejected',
        rejected_by: req.user.uid,
        rejection_reason: reason,
        rejected_at: new Date().toISOString(),
      },
      actor: req.user.uid,
      action: 'STAFF_DENIED',
      data: { from: current, to: STATES.REJECTED, reason }
    });

    res.json({ success: true, status: STATES.REJECTED, returnRecord: updated });
  });

  // ── 10. POST /agent/returns/:id/override ──────────────────────────────────
  // An override is a human reversing a human. It may ONLY lift a case out of
  // HUMAN_REVIEW, and only into APPROVED or REJECTED. Refunds are unreachable:
  // they can only be produced by warehouse INSPECTION → refund saga.
  const OverrideBodySchema = z.object({
    targetStatus: z.enum([STATES.APPROVED, STATES.REJECTED]),
    reason:       z.string().min(1),
  });

  router.post('/agent/returns/:id/override', verifyIdToken, requireRole('staff', 'admin'), async (req, res) => {
    const returnId = req.params.id;
    const parsed = OverrideBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'targetStatus (APPROVED or REJECTED) and reason required', issues: parsed.error.issues });
    }

    const { targetStatus, reason } = parsed.data;
    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return case not found' });

    const current = normalizeStatus(record.status);
    if (current !== STATES.HUMAN_REVIEW) {
      return res.status(409).json({
        error: `Override is only allowed from HUMAN_REVIEW. Current state: '${record.status}'.`
      });
    }

    try {
      assertTransition(current, targetStatus);
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }

    const { updated } = await saveWithAudit({
      returnRecord: {
        ...record,
        id: record.id,
        status: targetStatus,
        status_label: targetStatus === STATES.APPROVED ? 'RMA Approved' : 'Rejected',
        override_by: req.user.uid,
        override_reason: reason,
        override_at: new Date().toISOString(),
      },
      actor: req.user.uid,
      action: 'STAFF_OVERRIDE',
      data: { from: current, to: targetStatus, reason }
    });

    res.json({ success: true, status: targetStatus, returnRecord: updated });
  });

  // ── 11. POST /warehouse/returns/:id/receive ───────────────────────────────
  router.post('/warehouse/returns/:id/receive', verifyIdToken, requireRole('warehouse', 'staff', 'admin'), async (req, res) => {
    const returnId = req.params.id;
    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return case not found' });

    const current = normalizeStatus(record.status);
    try {
      assertTransition(current, STATES.RECEIVED);
    } catch (e) {
      return res.status(409).json({
        error: `Cannot receive package in state '${record.status}'. Expected IN_TRANSIT. ${e.message}`
      });
    }

    const { updated } = await saveWithAudit({
      returnRecord: {
        ...record,
        id: record.id,
        status: STATES.RECEIVED,
        status_label: 'Received at Warehouse',
        warehouse_received_at: new Date().toISOString(),
        received_by: req.user.uid,
      },
      actor: req.user.uid,
      action: 'WAREHOUSE_RECEIVED',
      data: { from: current, to: STATES.RECEIVED }
    });

    res.json({ success: true, status: STATES.RECEIVED, returnRecord: updated });
  });

  // ── 12. POST /warehouse/returns/:id/inspect ───────────────────────────────
  const InspectBodySchema = z.object({
    passed:         z.boolean(),
    conditionNotes: z.string().optional().default(''),
    failureReason:  z.string().optional().default(''),
  });

  router.post('/warehouse/returns/:id/inspect', verifyIdToken, requireRole('warehouse', 'staff', 'admin'), async (req, res) => {
    const returnId = req.params.id;
    const parsed = InspectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Inspection payload invalid', issues: parsed.error.issues });
    }

    const { passed, conditionNotes, failureReason } = parsed.data;
    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return case not found' });

    const current = normalizeStatus(record.status);

    // Step 1 — the case must enter INSPECTION before anything is refunded.
    try {
      assertTransition(current, STATES.INSPECTION);
    } catch (e) {
      return res.status(409).json({
        error: `Cannot inspect package in state '${record.status}'. Expected RECEIVED. ${e.message}`
      });
    }

    const inspectionStart = await returnStore.saveReturn({
      db,
      returnRecord: {
        ...record,
        id: record.id,
        status: STATES.INSPECTION,
        status_label: 'Under Inspection',
        inspected_by: req.user.uid,
        inspected_at: new Date().toISOString(),
      }
    });

    // Step 2 — only now may the case leave INSPECTION for a refund or a rejection.
    let nextStatus;
    let refundRecord = null;

    if (passed) {
      nextStatus = STATES.REFUND_PROCESSING;
      try {
        assertTransition(STATES.INSPECTION, STATES.REFUND_PROCESSING);
      } catch (e) {
        return res.status(409).json({ error: e.message });
      }

      // Refund saga runs only from INSPECTION → REFUND_PROCESSING.
      try {
        const amount = Number(record.refund_amount) || Number(record.item?.price) || 100;
        refundRecord = await initiateRefund({
          returnId: record.id,
          amount,
          method: record.resolutionType === 'store_credit' ? 'store_credit' : 'original_payment',
          initiatedBy: req.user.uid,
        });

        if (refundRecord?.status === 'COMPLETED') {
          assertTransition(STATES.REFUND_PROCESSING, STATES.COMPLETED);
          nextStatus = STATES.COMPLETED;
        }
      } catch (refundErr) {
        console.warn('Refund initiation warning:', refundErr.message);
      }
    } else {
      nextStatus = STATES.REJECTED;
      try {
        assertTransition(STATES.INSPECTION, STATES.REJECTED);
      } catch (e) {
        return res.status(409).json({ error: e.message });
      }
    }

    const { updated } = await saveWithAudit({
      returnRecord: {
        ...inspectionStart,
        id: record.id,
        status: nextStatus,
        status_label: nextStatus === STATES.COMPLETED ? 'Refund Completed' : (passed ? 'Refund Processing' : 'Rejected at Inspection'),
        inspection_passed: passed,
        inspection_notes: conditionNotes || failureReason,
        inspected_by: req.user.uid,
        inspected_at: new Date().toISOString(),
        refund_record: refundRecord,
      },
      actor: req.user.uid,
      action: passed ? 'WAREHOUSE_INSPECTION_PASSED' : 'WAREHOUSE_INSPECTION_FAILED',
      data: {
        passed,
        nextStatus,
        notes: conditionNotes || failureReason,
        refundStatus: refundRecord?.status || 'N/A'
      }
    });

    res.json({ success: true, status: nextStatus, refund: refundRecord, returnRecord: updated });
  });

  // ── 13. POST /webhooks/carrier ────────────────────────────────────────────
  const CarrierWebhookSchema = z.object({
    returnId:       z.string().optional(),
    orderId:        z.string().optional(),
    trackingNumber: z.string().optional(),
    carrierStatus:  z.enum(['PICKED_UP', 'IN_TRANSIT', 'DELIVERED_TO_WAREHOUSE', 'DELIVERED', 'EXCEPTION']),
    timestamp:      z.string().optional(),
  }).refine(data => data.returnId || data.orderId, {
    message: 'Either returnId or orderId must be provided'
  });

  // Shared-secret gate: timing-safe compare, no Firebase account involved.
  function requireCarrierSecret(req, res, next) {
    const expected = carrierWebhookSecret();
    if (!expected) {
      return res.status(503).json({ error: 'Carrier webhook is not configured (CARRIER_WEBHOOK_SECRET missing)' });
    }
    const provided = req.get(CARRIER_SECRET_HEADER);
    if (!provided) {
      return res.status(401).json({ error: `Missing ${CARRIER_SECRET_HEADER} header` });
    }
    if (!secretsMatch(provided, expected)) {
      return res.status(403).json({ error: 'Invalid carrier webhook secret' });
    }
    next();
  }

  router.post('/webhooks/carrier', requireCarrierSecret, async (req, res) => {
    const parsed = CarrierWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid carrier webhook payload', issues: parsed.error.issues });
    }

    const { returnId, orderId, trackingNumber, carrierStatus } = parsed.data;

    // Handle order delivery event via carrier webhook
    if (carrierStatus === 'DELIVERED' || (orderId && !returnId)) {
      const targetOrderId = orderId || (returnId ? (await returnStore.getReturn({ db, identifier: returnId }))?.orderId : null);
      if (!targetOrderId && returnId) {
        return res.status(404).json({ error: 'Return case not found' });
      }
      if (!targetOrderId) {
        return res.status(400).json({ error: 'Order ID required for DELIVERED status' });
      }

      let updatedOrder;
      try {
        updatedOrder = await returnStore.updateOrderStatus({ db, orderId: targetOrderId, status: 'delivered' });
      } catch (err) {
        if (err instanceof OrderStatusError && err.code === 'ORDER_STATUS_FINAL') {
          // Idempotent: order is already delivered — return the existing record.
          updatedOrder = await returnStore.getOrder({ db, orderId: targetOrderId }) || { status: 'delivered' };
        } else {
          throw err;
        }
      }

      if (returnId) {
        const record = await returnStore.getReturn({ db, identifier: returnId });
        if (record) {
          await saveWithAudit({
            returnRecord: {
              ...record,
              carrier_tracking: trackingNumber || record.pickup_details?.tracking_number,
              last_carrier_status: carrierStatus,
              last_carrier_update: new Date().toISOString(),
            },
            actor: 'carrier_webhook',
            action: 'CARRIER_STATUS_UPDATE',
            data: { carrierStatus, trackingNumber }
          });
        }
      }
      return res.json({ success: true, orderId: targetOrderId, status: 'delivered', delivered_at: updatedOrder.delivered_at || null });
    }

    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return case not found' });

    const current = normalizeStatus(record.status);
    let targetStatus = current;

    if (carrierStatus === 'PICKED_UP' || carrierStatus === 'IN_TRANSIT') {
      targetStatus = STATES.IN_TRANSIT;
    } else if (carrierStatus === 'DELIVERED_TO_WAREHOUSE') {
      targetStatus = STATES.RECEIVED;
    } else if (carrierStatus === 'EXCEPTION') {
      targetStatus = STATES.HUMAN_REVIEW;
    }

    // Only legal transitions are accepted; anything else is refused outright.
    if (targetStatus !== current) {
      try {
        assertTransition(current, targetStatus);
      } catch (e) {
        return res.status(409).json({ error: `Carrier event '${carrierStatus}' refused: ${e.message}` });
      }
    }

    const { updated } = await saveWithAudit({
      returnRecord: {
        ...record,
        id: record.id,
        status: targetStatus,
        status_label: targetStatus === current ? record.status_label : targetStatus,
        carrier_tracking: trackingNumber || record.pickup_details?.tracking_number,
        last_carrier_status: carrierStatus,
        last_carrier_update: new Date().toISOString(),
      },
      actor: 'carrier_webhook',
      action: 'CARRIER_STATUS_UPDATE',
      data: { carrierStatus, trackingNumber, from: current, to: targetStatus }
    });

    res.json({ success: true, returnId: record.id, status: targetStatus });
  });



  // ── 14. GET /returns/:id/audit ────────────────────────────────────────────
  router.get('/returns/:id/audit', verifyIdToken, async (req, res) => {
    const returnId = req.params.id;
    const uid = req.user.uid;
    const isStaffOrAdmin = ['staff', 'admin', 'warehouse'].includes(req.user.role);

    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return case not found' });

    const owner = record.userId || record.user_id;
    if (owner !== uid && !isStaffOrAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view audit log' });
    }

    const events = await returnStore.getAuditEvents({ db, returnId: record.id });
    const verification = verifyChain(events);

    res.json({
      returnId: record.id,
      chainValid: verification.valid,
      eventCount: events.length,
      events,
      verification,
    });
  });

  return router;
}
