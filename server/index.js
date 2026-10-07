import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import crypto from 'node:crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { runLoop }          from './agent/loop.js';
import { verifyIdToken }    from './middleware/auth.js';
import { rateLimit }        from './middleware/rateLimit.js';
import * as conversations   from './agent/conversations.js';
import {
  analyzeEvidence, detectMimeType, storeEvidence, checkUploadRateLimit
} from './agent/evidence.js';
import * as session         from './agent/session.js';
import { createEvent, GENESIS_HASH } from './returns/audit.js';
import { assertTransition, normalizeStatus, STATES } from './returns/stateMachine.js';
import * as returnStore from './returns/store.js';
import { createReturnsRouter } from './routes/returns.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config(); // Load server/.env if present

const app = express();

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:5173',
  process.env.CLIENT_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.startsWith('http://localhost:')) {
      return callback(null, true);
    }
    return callback(new Error('Blocked by CORS policy'));
  },
  credentials: true
}));
app.use(express.json());

// ─── Auth middleware alias ──────────────────────────────────────────────────
const authMiddleware = verifyIdToken;

const PORT = process.env.PORT || 5000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';

// ─── Courier QR-pass token helpers ──────────────────────────────────────────
// Sign tokens with a server secret. Rotate COURIER_TOKEN_SECRET in env.
if (process.env.NODE_ENV === 'production' && !process.env.COURIER_TOKEN_SECRET) {
  throw new Error('COURIER_TOKEN_SECRET must be set in production');
}
const COURIER_TOKEN_SECRET = process.env.COURIER_TOKEN_SECRET || 'dev-courier-secret-CHANGE-IN-PROD';
const COURIER_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
// In-memory replay store: token → true. Persists for process lifetime.
// For multi-instance deploys, replace with Redis or Firestore.
const _usedCourierTokens = new Set();

/**
 * Generate a signed courier-intake token.
 * Payload: `<returnId>.<expiry_unix_ms>`
 * Signature: HMAC-SHA256(payload, secret)
 */
export function generateCourierToken(returnId) {
  const expiry = Date.now() + COURIER_TOKEN_TTL_MS;
  const payload = `${returnId}.${expiry}`;
  const sig = crypto.createHmac('sha256', COURIER_TOKEN_SECRET).update(payload).digest('hex');
  // Encode as base64url for safe URL embedding
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

/**
 * Constant-time hex compare of two SHA-256 digests.
 * Guards against malformed / wrong-length signatures blowing up (or being
 * compared byte-for-byte) inside crypto.timingSafeEqual.
 */
function signatureMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!/^[0-9a-f]{64}$/i.test(provided) || !/^[0-9a-f]{64}$/i.test(expected)) return false;
  return crypto.timingSafeEqual(
    Buffer.from(provided.toLowerCase(), 'utf8'),
    Buffer.from(expected.toLowerCase(), 'utf8')
  );
}

/**
 * Verify a courier-intake token.
 * Returns { ok: true, returnId } or { ok: false, error: string }
 */
export function verifyCourierToken(token, claimedReturnId) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'Missing courier token' };
  let raw;
  try { raw = Buffer.from(token, 'base64url').toString(); } catch {
    return { ok: false, error: 'Malformed token' };
  }
  const parts = raw.split('.');
  if (parts.length !== 3) return { ok: false, error: 'Malformed token structure' };
  const [returnId, expiryStr, sig] = parts;
  if (returnId !== claimedReturnId) return { ok: false, error: 'Token/return ID mismatch' };
  const expiry = parseInt(expiryStr, 10);
  if (isNaN(expiry) || Date.now() > expiry) return { ok: false, error: 'Token expired' };
  const payload = `${returnId}.${expiryStr}`;
  const expected = crypto.createHmac('sha256', COURIER_TOKEN_SECRET).update(payload).digest('hex');
  if (!signatureMatches(sig, expected)) {
    return { ok: false, error: 'Invalid token signature' };
  }
  if (_usedCourierTokens.has(token)) return { ok: false, error: 'Token already used (replay)' };
  return { ok: true, returnId };
}


// Initialize Firebase Admin if service account exists or default credentials
let db = null;
try {
  const serviceAccountPath = path.resolve(__dirname, '../serviceAccountKey.json');
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    if (!getApps().length) {
      initializeApp({
        credential: cert(serviceAccount)
      });
    }
  } else if (!getApps().length) {
    // Initialize with project ID from env
    const projectId = process.env.VITE_FIREBASE_PROJECT_ID || 'rrrrr-711b3';
    initializeApp({ projectId });
  }
  db = getFirestore();
} catch (err) {
  console.warn('Firebase Admin initialized without direct service account, checking fallback:', err.message);
}

// Fallback in-memory / cache vector store if Firestore Admin isn't authenticated directly
let productCache = [];

// Cosine similarity
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Local text representation for embedding
export function createSearchableText(product) {
  return `Product: ${product.name || ''}. Category: ${product.category || ''}. Description: ${product.description || ''}. Price: ₹${product.price || 0}. Stock: ${product.stock_quantity > 0 ? `${product.stock_quantity} in stock` : 'Out of stock'}.`;
}

// Extract structured filters from user query (e.g. price and stock constraints)
function extractFilters(query) {
  const filters = {
    maxPrice: null,
    minPrice: null,
    inStockOnly: false,
    category: null
  };

  const cleanQ = query.toLowerCase();

  // Price checks: under/below/less than X or <= X
  const underMatch = cleanQ.match(/(?:under|below|less than|within|max(?:imum)?)\s*(?:rs\.?|inr|₹)?\s*([0-9]+(?:,[0-9]+)*)/i) ||
                     cleanQ.match(/(?:rs\.?|inr|₹)\s*([0-9]+(?:,[0-9]+)*)\s*(?:or less|under|below)/i);
  if (underMatch) {
    const rawVal = underMatch[1].replace(/,/g, '');
    filters.maxPrice = parseFloat(rawVal);
  }

  // Above / greater than X
  const aboveMatch = cleanQ.match(/(?:above|greater than|more than|minimum|at least)\s*(?:rs\.?|inr|₹)?\s*([0-9]+(?:,[0-9]+)*)/i);
  if (aboveMatch) {
    const rawVal = aboveMatch[1].replace(/,/g, '');
    filters.minPrice = parseFloat(rawVal);
  }

  // Stock checks
  if (/available|in stock|ready to ship|currently available/i.test(cleanQ)) {
    filters.inStockOnly = true;
  }

  return filters;
}

// Generate embedding using Gemini
async function getGeminiEmbedding(text) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

// API Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasGeminiKey: !!GEMINI_API_KEY,
    productsCached: productCache.length
  });
});

// Endpoint to sync/update products into server vector cache (accepts products list from admin or sync script)
app.post('/api/sync-products', async (req, res) => {
  try {
    const { products } = req.body;
    if (!products || !Array.isArray(products)) {
      return res.status(400).json({ error: 'Array of products required.' });
    }

    const indexed = [];
    for (const p of products) {
      if (!p.id || !p.name) continue;
      let embedding = p.embedding;
      if (!embedding && GEMINI_API_KEY) {
        try {
          const searchable = createSearchableText(p);
          embedding = await getGeminiEmbedding(searchable);
        } catch (e) {
          console.error(`Failed to embed product ${p.name}:`, e.message);
        }
      }
      indexed.push({
        ...p,
        embedding: embedding || null
      });
    }

    productCache = indexed;
    res.json({ message: 'Products indexed successfully', count: indexed.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Main AI Assistant RAG Chat Endpoint (Requires Auth + Server-Side Catalog)
app.post('/api/chat', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message query is required' });
    }

    // Server-side product catalog only (productCache or Firestore)
    let productsList = productCache;

    // If empty and Firestore db available, try fetching from Firestore
    if (productsList.length === 0 && db) {
      try {
        const snap = await db.collection('products').get();
        productsList = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } catch (dbErr) {
        console.warn('Could not fetch products from Firestore Admin directly:', dbErr.message);
      }
    }

    if (!productsList || productsList.length === 0) {
      return res.json({
        reply: "I couldn't access the product catalog at the moment. Please make sure products exist in the store.",
        products: []
      });
    }

    const filters = extractFilters(message);
    const query = message.trim();

    // 1. Semantic search with embeddings (or keyword/token overlap fallback if key missing)
    let scoredProducts = [];

    let queryEmbedding = null;
    if (GEMINI_API_KEY) {
      try {
        queryEmbedding = await getGeminiEmbedding(query);
      } catch (embErr) {
        console.warn('Gemini embedding failed, using keyword fallback:', embErr.message);
      }
    }

    for (const prod of productsList) {
      // Apply strict price and stock filters first
      const price = Number(prod.price) || 0;
      const stock = Number(prod.stock_quantity) || 0;

      if (filters.maxPrice !== null && price > filters.maxPrice) {
        continue;
      }
      if (filters.minPrice !== null && price < filters.minPrice) {
        continue;
      }
      if (filters.inStockOnly && stock <= 0) {
        continue;
      }

      let similarityScore = 0;

      if (queryEmbedding && prod.embedding && Array.isArray(prod.embedding)) {
        similarityScore = cosineSimilarity(queryEmbedding, prod.embedding);
      } else {
        // High quality Lexical/Jaccard + substring fallback
        const searchable = (prod.name + ' ' + (prod.category || '') + ' ' + (prod.description || '')).toLowerCase();
        const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
        let matches = 0;
        for (const term of queryTerms) {
          if (searchable.includes(term)) matches++;
        }
        similarityScore = queryTerms.length > 0 ? (matches / queryTerms.length) : 0;
        if (searchable.includes(query.toLowerCase())) similarityScore += 0.5;
      }

      scoredProducts.push({
        product: prod,
        score: similarityScore
      });
    }

    // Sort by relevance
    scoredProducts.sort((a, b) => b.score - a.score);

    // Pick top candidates (max 5)
    let candidateList = scoredProducts
      .filter(item => (queryEmbedding ? item.score > 0.35 : item.score > 0))
      .slice(0, 5)
      .map(item => item.product);

    // If query has strict price/stock filters but no specific keywords match well, provide the filtered products
    if (candidateList.length === 0 && (filters.maxPrice !== null || filters.inStockOnly)) {
      candidateList = scoredProducts.slice(0, 5).map(item => item.product);
    }

    // 2. Synthesize response with Gemini using STRICT ground truth instructions
    let aiReply = "";

    if (GEMINI_API_KEY && candidateList.length > 0) {
      try {
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const catalogContext = candidateList.map((p, idx) => 
          `[Product ${idx + 1}]
ID: ${p.id}
Name: ${p.name}
Category: ${p.category || 'General'}
Price: ₹${p.price}
Stock: ${p.stock_quantity} units (${p.stock_quantity > 0 ? 'In Stock' : 'Out of Stock'})
Description: ${p.description || 'No description available.'}`
        ).join('\n\n');

        const prompt = `System Instruction:
You are the AI shopping assistant for this ecommerce store.
Only answer using the products and information supplied below.
Never invent products, prices, stock quantities, specifications, discounts, or availability.
If the catalog does not contain a suitable product, clearly say so.
Use current Firestore price (₹) and stock values provided in the context.
Keep your response concise, helpful, friendly, and formatted in clean markdown.

User Question: "${query}"

Available Products from Store Catalog:
${catalogContext}

Answer the user directly and reference the relevant products.`;

        const result = await model.generateContent(prompt);
        aiReply = result.response.text();
      } catch (genErr) {
        console.error('Gemini generation error:', genErr.message);
        aiReply = `I found ${candidateList.length} matching product${candidateList.length > 1 ? 's' : ''} in our catalog for you:`;
      }
    } else if (candidateList.length > 0) {
      aiReply = `Here are the matching products from our store catalog for "${query}":`;
    } else {
      aiReply = `I couldn't find any products in our catalog matching "${query}". Try searching for categories like electronics, sports, clothing, or adjusting your price filters.`;
    }

    // Return the response along with structured real Firestore documents
    res.json({
      reply: aiReply,
      products: candidateList.map(p => ({
        id: p.id,
        name: p.name,
        price: p.price,
        stock_quantity: p.stock_quantity,
        category: p.category,
        description: p.description,
        images: p.images || []
      }))
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// ─── Multer — memory storage, 5 MB limit ────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
});

// ─── POST /agent/chat ────────────────────────────────────────────────────────
const AgentChatBodySchema = z.object({
  message:        z.string().min(1).max(2000),
  conversationId: z.string().min(1).max(128),
});

app.post('/agent/chat',
  authMiddleware,
  rateLimit({ max: 20, windowMs: 60_000 }),
  async (req, res) => {
    const parsed = AgentChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
    }
    const { message, conversationId } = parsed.data;
    const uid = req.user.uid;

    // Block if taken over by staff
    const conv = await conversations.loadConversation({ db, conversationId, uid }).catch(() => null);
    if (conv?.handledBy) {
      return res.json({
        reply: 'A team member is currently helping you with this case. Please wait for their response.',
        caseCard: conv.caseCard || {},
        auditEventCount: 0,
      });
    }

    try {
      const { reply, caseCard, auditEvents } = await runLoop({
        userMessage: message, conversationId, uid, db,
      });

      // Persist conversation for resume + staff audit
      await conversations.saveConversation({
        db, conversationId, uid,
        messages: session.getMessages(conversationId),
        caseCard,
        auditEvents,
      }).catch(() => {});

      // SSE: if client accepts text/event-stream, stream the reply word-by-word
      if (req.headers.accept === 'text/event-stream') {
        res.set({
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        });
        const words = reply.split(' ');
        for (const word of words) {
          res.write(`data: ${JSON.stringify({ token: word + ' ' })}\n\n`);
          await new Promise(r => setTimeout(r, 30));
        }
        res.write(`data: ${JSON.stringify({ done: true, caseCard, auditEventCount: auditEvents.length })}\n\n`);
        res.end();
      } else {
        res.json({ reply, caseCard, auditEventCount: auditEvents.length });
      }
    } catch (err) {
      console.error('/agent/chat error:', err);
      res.status(500).json({ error: 'Agent encountered an internal error.', detail: err.message });
    }
  }
);

// ─── POST /agent/evidence ────────────────────────────────────────────────────
app.post('/agent/evidence',
  authMiddleware,
  upload.single('file'),
  async (req, res) => {
    const uid            = req.user.uid;
    const conversationId = req.body?.conversationId;
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
    if (!req.file)       return res.status(400).json({ error: 'No file uploaded' });

    // Reject by content, not extension
    const mimeType = detectMimeType(req.file.buffer);
    if (!mimeType) {
      return res.status(415).json({ error: 'Unsupported file type. Upload a JPEG, PNG, or WebP image.' });
    }

    // Rate limit: 5 uploads/hour/case
    if (!checkUploadRateLimit(conversationId)) {
      return res.status(429).json({ error: 'Upload limit reached (5 per hour per case). Try again later.' });
    }

    const result = await analyzeEvidence({ imageBuffer: req.file.buffer, mimeType });
    const record = storeEvidence({ conversationId, ...result });

    // Safe audit event
    const ev = createEvent({
      returnId:     conversationId,
      previousHash: GENESIS_HASH,
      actor:        uid,
      action:       'EVIDENCE_UPLOADED',
      data:         { hash: result.hash, mimeType, sizeBytes: result.sizeBytes, verified: result.verified },
    });

    res.json({
      evidenceId:  record.evidenceId,
      hash:        result.hash,
      verified:    result.verified,
      // Analysis is returned to the agent as UNTRUSTED DATA (wrapped in delimiter on client)
      analysis:    result.analysis,
      confidence:  result.confidence,
      auditEvent:  ev,
    });
  }
);

// ─── GET /agent/conversations/:id ────────────────────────────────────────────
app.get('/agent/conversations/:id',
  authMiddleware,
  async (req, res) => {
    const { uid, role } = req.user;
    const isStaffOrAdmin = role === 'staff' || role === 'admin';
    const conv = await conversations.loadConversation({ db, conversationId: req.params.id, uid, isStaffOrAdmin });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    res.json(conv);
  }
);

// ─── POST /agent/conversations/:id/staff-reply ───────────────────────────────
app.post('/agent/conversations/:id/staff-reply',
  authMiddleware,
  async (req, res) => {
    const { role, uid } = req.user;
    if (role !== 'staff' && role !== 'admin') {
      return res.status(403).json({ error: 'Staff or admin role required' });
    }
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message is required' });

    const conversationId = req.params.id;
    try {
      const staffMsg = await conversations.appendStaffReply({ db, conversationId, staffUid: uid, message });
      res.json({ ok: true, message: staffMsg });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  }
);

// ─── POST /agent/conversations/:id/takeover ───────────────────────────────────
app.post('/agent/conversations/:id/takeover',
  authMiddleware,
  async (req, res) => {
    const { role, uid } = req.user;
    if (role !== 'staff' && role !== 'admin') {
      return res.status(403).json({ error: 'Staff or admin role required' });
    }
    const conversationId = req.params.id;
    const ev = createEvent({
      returnId: conversationId, previousHash: GENESIS_HASH,
      actor: uid, action: 'STAFF_TAKEOVER', data: { staffUid: uid, handledBy: 'human' },
    });
    try {
      await conversations.setHandledBy({ db, conversationId, handledBy: 'human', actorUid: uid, auditEvent: ev });
      res.json({ ok: true, handledBy: 'human' });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  }
);

// ─── POST /agent/conversations/:id/handback ───────────────────────────────────
app.post('/agent/conversations/:id/handback',
  authMiddleware,
  async (req, res) => {
    const { role, uid } = req.user;
    if (role !== 'staff' && role !== 'admin') {
      return res.status(403).json({ error: 'Staff or admin role required' });
    }
    const conversationId = req.params.id;
    const ev = createEvent({
      returnId: conversationId, previousHash: GENESIS_HASH,
      actor: uid, action: 'STAFF_HANDBACK', data: { staffUid: uid },
    });
    try {
      await conversations.setHandledBy({ db, conversationId, handledBy: null, actorUid: uid, auditEvent: ev });
      res.json({ ok: true, handledBy: null });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  }
);

// ─── GET /agent/inbox (staff needs-human list) ────────────────────────────────
app.get('/agent/inbox',
  authMiddleware,
  async (req, res) => {
    const { role } = req.user;
    if (role !== 'staff' && role !== 'admin') {
      return res.status(403).json({ error: 'Staff or admin role required' });
    }
    const list = await conversations.listNeedsHuman({ db, limitN: 25 });
    res.json({ cases: list });
  }
);

// ─── POST /api/orders (Create order securely on server) ──────────────────────
app.post('/api/orders', authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const orderData = req.body;
  if (!orderData) return res.status(400).json({ error: 'Order data is required' });

  const customerUid = orderData.customer?.user_id || orderData.user_id;
  if (customerUid !== uid && req.user.role !== 'admin' && req.user.role !== 'staff') {
    return res.status(403).json({ error: 'Unauthorized to create order for another user' });
  }

  // Server sets and controls status, delivered_at, returns
  delete orderData.delivered_at;
  delete orderData.returns;
  orderData.status = 'processing';
  orderData.created_at = db ? FieldValue.serverTimestamp() : new Date().toISOString();
  orderData.updated_at = db ? FieldValue.serverTimestamp() : new Date().toISOString();

  try {
    let orderId = `ord_${Date.now()}`;
    if (db) {
      const docRef = await db.collection('orders').add(orderData);
      orderId = docRef.id;

      // Safely decrement stock for purchased items
      if (Array.isArray(orderData.items)) {
        for (const item of orderData.items) {
          const pId = item.product_id || item.id;
          if (pId && item.quantity) {
            try {
              const pRef = db.collection('products').doc(pId);
              await pRef.update({
                stock_quantity: FieldValue.increment(-Number(item.quantity))
              });
            } catch (stockErr) {
              console.warn(`Could not update stock for product ${pId}:`, stockErr.message);
            }
          }
        }
      }
    }
    res.status(201).json({ success: true, id: orderId, order: { ...orderData, id: orderId } });
  } catch (err) {
    console.error('Error creating order:', err);
    res.status(500).json({ error: 'Failed to create order', detail: err.message });
  }
});

// ─── POST /api/orders/:id/deliver (Staff / Admin package delivery) ───────────
app.post('/api/orders/:id/deliver', authMiddleware, async (req, res) => {
  const { role } = req.user;
  if (role !== 'admin' && role !== 'staff') {
    return res.status(403).json({ error: 'Admin or Staff role required to simulate delivery' });
  }
  const orderId = req.params.id;
  try {
    if (db) {
      const orderRef = db.collection('orders').doc(orderId);
      await orderRef.update({
        status: 'delivered',
        delivered_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
    }
    res.json({ success: true, orderId, status: 'delivered' });
  } catch (err) {
    console.error('Error marking order delivered:', err);
    res.status(500).json({ error: 'Failed to update order delivery', detail: err.message });
  }
});

// ─── PATCH /api/orders/:id/status (Staff status change) ──────────────────────
app.patch('/api/orders/:id/status', authMiddleware, async (req, res) => {
  const { role } = req.user;
  if (role !== 'admin' && role !== 'staff') {
    return res.status(403).json({ error: 'Admin or Staff role required' });
  }
  const orderId = req.params.id;
  const { status } = req.body || {};
  if (!status || typeof status !== 'string') return res.status(400).json({ error: 'Status is required' });

  try {
    const updated = await returnStore.updateOrderStatus({ db, orderId, status });
    res.json({
      success: true,
      orderId,
      status: updated ? updated.status : status,
      delivered_at: updated ? updated.delivered_at || null : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order status', detail: err.message });
  }
});

// ─── Products CRUD Endpoints (Server writes only) ───────────────────────────
app.post('/api/products', authMiddleware, async (req, res) => {
  const { role } = req.user;
  if (role !== 'admin' && role !== 'staff') {
    return res.status(403).json({ error: 'Admin or Staff role required' });
  }
  const productData = req.body;
  productData.created_at = db ? FieldValue.serverTimestamp() : new Date().toISOString();
  try {
    let id = `prod_${Date.now()}`;
    if (db) {
      const ref = await db.collection('products').add(productData);
      id = ref.id;
    }
    res.status(201).json({ success: true, id, product: { ...productData, id } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add product', detail: err.message });
  }
});

app.put('/api/products/:id', authMiddleware, async (req, res) => {
  const { role } = req.user;
  if (role !== 'admin' && role !== 'staff') {
    return res.status(403).json({ error: 'Admin or Staff role required' });
  }
  const id = req.params.id;
  const productData = req.body;
  delete productData.id;
  try {
    if (db) {
      await db.collection('products').doc(id).set(productData, { merge: true });
    }
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product', detail: err.message });
  }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  const { role } = req.user;
  if (role !== 'admin' && role !== 'staff') {
    return res.status(403).json({ error: 'Admin or Staff role required' });
  }
  const id = req.params.id;
  try {
    if (db) {
      await db.collection('products').doc(id).delete();
    }
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product', detail: err.message });
  }
});

// NOTE: POST /api/courier/verify was removed. It wrote a status
// ('COURIER_PICKED_UP') that does not exist in the state machine and acted as
// an unauthenticated-signature twin of /api/returns/:id/courier-intake.
// The signed, expiring courier token endpoint below is the single courier path.

// ─── POST /api/returns/:id/resolve ──────────────────────────────────────────
app.post('/api/returns/:id/resolve', authMiddleware, async (req, res) => {
  const { role, uid } = req.user;
  if (role !== 'admin' && role !== 'staff') {
    return res.status(403).json({ error: 'Admin or Staff role required' });
  }
  const returnId = req.params.id;
  const { resolution = 'RESOLVED' } = req.body || {};

  // Map the caller's resolution onto a canonical state, then let the state
  // machine decide whether that move is legal.
  const RESOLUTION_ALIASES = {
    REFUNDED:  STATES.COMPLETED,
    RESOLVED:  STATES.COMPLETED,
    INSPECTED: STATES.INSPECTION,
  };
  const targetStatus = STATES[resolution] || RESOLUTION_ALIASES[String(resolution).toUpperCase()] || null;

  if (!targetStatus) {
    return res.status(400).json({ error: `Unknown resolution '${resolution}'` });
  }

  try {
    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return not found' });

    const current = normalizeStatus(record.status);
    if (current !== targetStatus) {
      assertTransition(current, targetStatus);
    }

    const prevHash = await returnStore.getLatestEventHash({ db, returnId: record.id });
    const ev = createEvent({
      returnId: record.id,
      previousHash: prevHash || GENESIS_HASH,
      actor: uid,
      action: 'RESOLVED_BY_STAFF',
      data: { from: current, to: targetStatus, resolution }
    });

    // Return write + audit event land in the same Firestore batch.
    const updated = await returnStore.saveReturn({
      db,
      returnRecord: {
        ...record,
        id: record.id,
        status: targetStatus,
        status_label: targetStatus,
        resolved_by: uid,
        resolved_at: new Date().toISOString(),
        resolution,
      },
      event: ev,
    });

    res.json({ success: true, returnId: record.id, status: targetStatus, returnRecord: updated });
  } catch (err) {
    if (err && err.name === 'ReturnStateError') {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to resolve return', detail: err.message });
  }
});

// ─── POST /api/returns/:id/courier-token (generate signed QR token) ──────────
// Called when the customer opens their QR pass page. Returns a signed token
// that the courier page embeds in its intake POST (no Firebase account needed).
app.post('/api/returns/:id/courier-token', authMiddleware, async (req, res) => {
  const returnId = req.params.id;
  const uid = req.user.uid;

  try {
    // Verify the caller owns this return (or is staff/admin)
    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return not found' });

    const owner = record.user_id || record.userId;
    if (owner !== uid && req.user.role !== 'admin' && req.user.role !== 'staff') {
      return res.status(403).json({ error: 'Not your return' });
    }

    const token = generateCourierToken(record.id);
    res.json({ token, ttlSeconds: Math.floor(COURIER_TOKEN_TTL_MS / 1000) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate courier token', detail: err.message });
  }
});

// ─── POST /api/returns/:id/courier-intake ────────────────────────────────────
// Public endpoint — no Firebase account required. Auth is the signed QR token.
// Token must be signed, unexpired, and single-use (replay protection).
// Only advances PICKUP_SCHEDULED → IN_TRANSIT. Nothing else is written.
app.post('/api/returns/:id/courier-intake', async (req, res) => {
  const returnId = req.params.id;
  const { token } = req.body || {};

  // 1. Verify signed token
  const verification = verifyCourierToken(token, returnId);
  if (!verification.ok) {
    return res.status(401).json({ error: verification.error });
  }

  try {
    const record = await returnStore.getReturn({ db, identifier: returnId });
    if (!record) return res.status(404).json({ error: 'Return not found' });

    const current = normalizeStatus(record.status);

    // 2. Only PICKUP_SCHEDULED → IN_TRANSIT is accepted — anything else is 409.
    if (current !== STATES.PICKUP_SCHEDULED) {
      return res.status(409).json({
        error: `Cannot mark in-transit from status '${record.status}'. Expected PICKUP_SCHEDULED.`
      });
    }
    assertTransition(current, STATES.IN_TRANSIT);

    // 3. Audit event hash-chained to the existing log, written in the same
    //    Firestore batch as the return write.
    const prevHash = await returnStore.getLatestEventHash({ db, returnId: record.id });
    const ev = createEvent({
      returnId: record.id,
      previousHash: prevHash || GENESIS_HASH,
      actor: 'courier',
      action: 'COURIER_INTAKE_CONFIRMED',
      data: { from: current, to: STATES.IN_TRANSIT }
    });

    // 4. Write only the fields we control — ignore everything else the caller sends
    await returnStore.saveReturn({
      db,
      returnRecord: {
        ...record,
        id: record.id,
        status: STATES.IN_TRANSIT,
        status_label: 'In Transit',
        courier_intake_verified: true,
        courier_intake_timestamp: new Date().toISOString(),
      },
      event: ev,
    });

    // 5. Mark token as used (replay protection) — only after successful write
    _usedCourierTokens.add(token);

    res.json({ success: true, returnId: record.id, status: STATES.IN_TRANSIT });
  } catch (err) {
    if (err && err.name === 'ReturnStateError') {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to record courier intake', detail: err.message });
  }
});

// ─── Returns Router (Phase 4 Deliverables) ──────────────────────────────────
const returnsRouter = createReturnsRouter(db);
app.use(returnsRouter);
app.use('/api', returnsRouter);

const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('server\\index.js') ||
  process.argv[1].endsWith('server/index.js') ||
  process.argv[1].endsWith('index.js')
) && !process.env.NODE_TEST_CONTEXT;

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`AI Shopping Assistant Server running on port ${PORT}`);
  });
}

export { app };
