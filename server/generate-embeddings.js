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
dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('Error: GEMINI_API_KEY is not defined in environment variables.');
  process.exit(1);
}

const serviceAccountPath = path.resolve(__dirname, '../serviceAccountKey.json');
if (fs.existsSync(serviceAccountPath)) {
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
} else {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || 'rrrrr-711b3';
  if (!getApps().length) {
    initializeApp({ projectId });
  }
}

const db = getFirestore();
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

export function createSearchableText(product) {
  return `Product: ${product.name || ''}. Category: ${product.category || ''}. Description: ${product.description || ''}. Price: ₹${product.price || 0}. Stock: ${product.stock_quantity > 0 ? `${product.stock_quantity} units in stock` : 'Out of stock'}.`;
}

async function generateAllEmbeddings() {
  console.log('🚀 Starting embedding generation for Firestore products collection...');
  try {
    const snapshot = await db.collection('products').get();
    if (snapshot.empty) {
      console.log('No products found in Firestore.');
      return;
    }

    console.log(`Found ${snapshot.size} products. Processing embeddings...`);

    let count = 0;
    for (const docSnapshot of snapshot.docs) {
      const product = { id: docSnapshot.id, ...docSnapshot.data() };
      const searchableText = createSearchableText(product);
      
      console.log(`[${count + 1}/${snapshot.size}] Embedding: "${product.name}"...`);
      const result = await embeddingModel.embedContent(searchableText);
      const embeddingValues = result.embedding.values;

      // Update Firestore document with embedding vector safely without modifying price/stock/etc.
      await db.collection('products').doc(product.id).update({
        embedding: embeddingValues,
        embedding_updated_at: new Date().toISOString()
      });

      count++;
    }

    console.log(`✅ Finished! Successfully indexed ${count} products with Gemini embeddings.`);
  } catch (err) {
    console.error('❌ Error during embedding generation:', err);
  }
}

generateAllEmbeddings();
