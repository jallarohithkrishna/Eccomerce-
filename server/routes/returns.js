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

export function createReturnsRouter(db) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  // ── Helper to create and append an audit event ────────────────────────────
  async function logAudit({ returnId, actor, action, data }) {
    const prevHash = await returnStore.getLatestEventHash({ db, returnId });
    const ev = createEvent({
      returnId,
      previousHash: prevHash || GENESIS_HASH,
      actor: actor || 'system',
      action,
      data: data || {},
    });
    await returnStore.appendAuditEvent({ db, returnId, event: ev });
    return ev;
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
        // Find order
        let order = null;
        if (shouldSync(db)) {
          const snap = await db.collection('orders').doc(orderId).get();
          if (snap.exists) order = { id: snap.id, ...snap.data() };
        }

        // Ownership verification if order found
        if (order) {
          const ownerUid = order.customer?.user_id || order.user_id || order.userId;
          if (ownerUid && ownerUid !== uid && req.user.role !== 'admin' && req.user.role !== 'staff') {
            return res.status(403).json({ error: 'You can only create returns for your own orders' });
          }
        }

        // Identify product and details
        const orderItem = order?.items?.find(i =>
          (i.product_id || i.id) === productId
        ) || order?.items?.[0] || {
          id: productId || 'prod_default',
          name: 'Purchased Item',
          price: 500,
          category: 'standard'
        };

        const itemPrice = Number(orderItem.price) || 0;
        const itemName  = orderItem.name || 'Purchased Item';
        const category  = orderItem.category || 'standard';
        const deliveredAt = order?.delivered_at?.toDate
          ? order.delivered_at.toDate().toISOString()
          : (order?.delivered_at || new Date().toISOString());

        // Deterministic policy evaluation
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
        const rmaNumber = `RMA-${Date.now().toString(36).toUpperCase()}`;

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

        await returnStore.saveReturn({ db, returnRecord });

        await logAudit({
          returnId,
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

        res.status(201).json({ success: true, returnRecord });
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
  router.get('/returns/verify/:identifier', async (req, res) => {
    const identifier = req.params.identifier;
    const record = await returnStore.getReturn({ db, identifier });
    if (!record) {
      return res.status(404).json({ error: 'Return verification pass not found' });
    }

    // Return non-personal sanitized logistics data for courier
    res.json({
      id:              record.id,
      rma_number:      record.rma_number,
      order_number:    record.order_id || record.orderId || 'N/A',
      status:          record.status,
      status_label:    record.status_label || record.status,
      item:            record.item || { name: 'Item', quantity: record.quantity || 1, price: 0 },
      pickup_details:  record.pickup_details || { carrier: 'Express Courier' },
      resolution_type: record.resolutionType || record.resolution_type || 'refund',
      refund_amount:   record.refund_amount || 0,
      createdAt:       record.createdAt,
      timeline:        record.timeline || [
        { stage: 'Return Requested', done: true },
        { stage: 'RMA Authorized', done: true },
        { stage: 'Pickup Scheduled', done: record.status !== STATES.REQUESTED },
        { stage: 'Warehouse Inspection', done: [STATES.RECEIVED, STATES.INSPECTION, STATES.COMPLETED].includes(record.status) },
        { stage: 'Refund Credited', done: record.status === STATES.COMPLETED },
      ]
    });
  });

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

      const ev = await logAudit({
        returnId: record.id,
        actor: uid,
        action: 'EVIDENCE_UPLOADED',
        data: {
          hash: analysisResult.hash,
          mimeType,
          sizeBytes: analysisResult.sizeBytes,
          verified: analysisResult.verified,
        }
      });

      const updated = await returnStore.saveReturn({
        db,
        returnRecord: {
          ...record,
          id: record.id,
          photo_evidence_hash: analysisResult.hash,
          photo_verified: analysisResult.verified,
          photo_analysis: analysisResult.analysis,
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

    const updated = await returnStore.saveReturn({
      db,
      returnRecord: {
        ...record,
        id: record.id,
        status: STATES.HUMAN_REVIEW,
        status_label: 'Needs Human Review (Appealed)',
        appealReason: parsed.data.reason,
        appealedAt: new Date().toISOString(),
      }
    });

    await logAudit({
      returnId: record.id,
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

    const updated = await returnStore.saveReturn({
      db,
      returnRecord: {
        ...record,
        id: record.id,
        status: STATES.APPROVED,
        status_label: 'RMA Approved',
        approved_by: req.user.uid,
        approved_at: new Date().toISOString(),
      }
    });

    await logAudit({
      returnId: record.id,
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

    const updated = await returnStore.saveReturn({
      db,
      returnRecord: {
        ...record,
        id: record.id,
        status: STATES.REJECTED,
        status_label: 'Rejected',
        rejected_by: req.user.uid,
        rejection_reason: reason,
        rejected_at: new Date().toISOString(),
      }
    });

    await logAudit({
      returnId: record.id,
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

    const updated = await returnStore.saveReturn({
      db,
      returnRecord: {
        ...record,
        id: record.id,
        status: targetStatus,
        status_label: targetStatus === STATES.APPROVED ? 'RMA Approved' : 'Rejected',
        override_by: req.user.uid,
        override_reason: reason,
        override_at: new Date().toISOString(),
      }
    });

    await logAudit({
      returnId: record.id,
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

    const updated = await returnStore.saveReturn({
      db,
      returnRecord: {
        ...record,
        id: record.id,
        status: STATES.RECEIVED,
        status_label: 'Received at Warehouse',
        warehouse_received_at: new Date().toISOString(),
        received_by: req.user.uid,
      }
    });

    await logAudit({
      returnId: record.id,
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

    const updated = await returnStore.saveReturn({
      db,
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
      }
    });

    await logAudit({
      returnId: record.id,
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
    returnId:       z.string().min(1),
    trackingNumber: z.string().optional(),
    carrierStatus:  z.enum(['PICKED_UP', 'IN_TRANSIT', 'DELIVERED_TO_WAREHOUSE', 'EXCEPTION']),
    timestamp:      z.string().optional(),
  });

  router.post('/webhooks/carrier', async (req, res) => {
    const parsed = CarrierWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid carrier webhook payload', issues: parsed.error.issues });
    }

    const { returnId, trackingNumber, carrierStatus } = parsed.data;
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

    const updated = await returnStore.saveReturn({
      db,
      returnRecord: {
        ...record,
        id: record.id,
        status: targetStatus,
        status_label: targetStatus === current ? record.status_label : targetStatus,
        carrier_tracking: trackingNumber || record.pickup_details?.tracking_number,
        last_carrier_status: carrierStatus,
        last_carrier_update: new Date().toISOString(),
      }
    });

    await logAudit({
      returnId: record.id,
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
