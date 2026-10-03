import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

const PORT = process.env.PORT || 5000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';

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

// Main AI Assistant RAG Chat Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, catalog } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message query is required' });
    }

    // Use current catalog supplied by client or server cache
    let productsList = (catalog && Array.isArray(catalog) && catalog.length > 0) ? catalog : productCache;

    // If both empty and Firestore db available, try fetching from Firestore
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

app.listen(PORT, () => {
  console.log(`AI Shopping Assistant Server running on port ${PORT}`);
});
