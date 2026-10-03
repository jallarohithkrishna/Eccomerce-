import { getCachedProducts, ensureProductsLoaded } from './productCache';

const SERVER_URL = import.meta.env.VITE_AI_SERVER_URL || 'http://localhost:5000';

/**
 * Fallback client-side smart semantic & keyword filter if server is unavailable
 */
export function searchClientProducts(products, query) {
  if (!products || !products.length) return { reply: "Catalog is currently empty.", products: [] };
  
  const cleanQ = query.toLowerCase();
  
  // Extract price constraints
  let maxPrice = null;
  const underMatch = cleanQ.match(/(?:under|below|less than|within|max(?:imum)?)\s*(?:rs\.?|inr|₹)?\s*([0-9]+(?:,[0-9]+)*)/i) ||
                     cleanQ.match(/(?:rs\.?|inr|₹)\s*([0-9]+(?:,[0-9]+)*)\s*(?:or less|under|below)/i);
  if (underMatch) {
    maxPrice = parseFloat(underMatch[1].replace(/,/g, ''));
  }

  const inStockOnly = /available|in stock|ready to ship/i.test(cleanQ);

  const queryTokens = cleanQ
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !['show', 'find', 'give', 'need', 'product', 'products', 'under', 'below', 'with', 'for', 'the'].includes(t));

  const scored = [];

  for (const p of products) {
    const price = Number(p.price) || 0;
    const stock = Number(p.stock_quantity) || 0;

    if (maxPrice !== null && price > maxPrice) continue;
    if (inStockOnly && stock <= 0) continue;

    const targetText = `${p.name} ${p.category || ''} ${p.description || ''}`.toLowerCase();
    
    let score = 0;
    for (const token of queryTokens) {
      if (targetText.includes(token)) score += 10;
      if (p.name.toLowerCase().includes(token)) score += 20;
      if ((p.category || '').toLowerCase().includes(token)) score += 15;
    }

    if (queryTokens.length === 0) {
      score = 1; // if query was just "under ₹5000", keep all matching price
    }

    if (score > 0) {
      scored.push({ product: p, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const matched = scored.slice(0, 6).map(s => s.product);

  let reply = "";
  if (matched.length > 0) {
    reply = `I found ${matched.length} product${matched.length > 1 ? 's' : ''} matching your search:`;
  } else {
    reply = `I couldn't find any products matching "${query}" in our current catalog. Try checking spelling or adjusting filters.`;
  }

  return { reply, products: matched };
}

/**
 * Ask AI Assistant via RAG backend server or client-side fallback
 */
export async function askAiAssistant(userMessage, localCatalog = []) {
  // 1. First fetch fresh real products from cache if not provided
  let catalog = localCatalog;
  if (!catalog || catalog.length === 0) {
    catalog = getCachedProducts();
    if (!catalog || catalog.length === 0) {
      try {
        catalog = await ensureProductsLoaded();
      } catch (err) {
        console.warn('Could not read products from cache:', err);
      }
    }
  }

  // 2. Try calling backend RAG server
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`${SERVER_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userMessage, catalog }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch (err) {
    console.log('AI server unavailable, using local client RAG fallback:', err.message);
  }

  // 3. Fallback client RAG
  return searchClientProducts(catalog, userMessage);
}
