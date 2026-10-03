/**
 * Module-level in-memory product cache.
 * Keeps a single shared real-time Firestore products listener for the whole app.
 * Replaces redundant whole-collection reads across pages and assistants.
 */
import { db } from './firebase';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';

// ─── Cache State ──────────────────────────────────────────────────────────────
let _products = [];
let _productMap = {};   // id → product (O(1) lookup)
let _lastFetched = null;
let _unsubscribe = null;
let _listeners = new Set();
let _initialized = false;
let _initPromise = null;

const STALE_MS = 5 * 60 * 1000; // 5 minutes

function _notify() {
  _listeners.forEach(fn => {
    try {
      fn(_products);
    } catch (e) {
      console.error('productCache subscriber error:', e);
    }
  });
}

function _startListener() {
  if (_unsubscribe && _initPromise) return _initPromise;

  const q = query(collection(db, 'products'), orderBy('created_at', 'desc'));
  
  _initPromise = new Promise((resolve) => {
    _unsubscribe = onSnapshot(q, (snap) => {
      _products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _productMap = Object.fromEntries(_products.map(p => [p.id, p]));
      _lastFetched = Date.now();
      _initialized = true;
      _notify();
      resolve(_products);
    }, (err) => {
      console.warn('productCache listener warning:', err.message);
      resolve(_products);
    });
  });

  return _initPromise;
}

/**
 * Ensure products are loaded and listener is active.
 * @returns {Promise<Array>}
 */
export async function ensureProductsLoaded() {
  if (_initialized && _products.length > 0) return _products;
  return await _startListener();
}

/**
 * Subscribe to product list changes.
 * Immediately invokes callback with current cached products,
 * then updates whenever Firestore pushes a change.
 * Keeps the single shared listener active for the whole app session.
 *
 * @param {(products: Array) => void} callback
 * @returns {() => void} unsubscribe callback
 */
export function subscribeToProducts(callback) {
  _listeners.add(callback);
  _startListener();

  if (_initialized || _products.length > 0) {
    callback(_products);
  }

  return () => {
    _listeners.delete(callback);
  };
}

/**
 * Get current cached products synchronously.
 * Automatically starts the shared listener in background if not yet started.
 */
export function getCachedProducts() {
  _startListener();
  return _products;
}

/**
 * Get a single product by ID instantly from cache.
 */
export function getProductById(id) {
  return _productMap[id] ?? null;
}

/**
 * Whether the cache has been populated at least once.
 */
export function isCacheReady() {
  return _initialized;
}

/**
 * Whether the cached data is older than STALE_MS.
 */
export function isCacheStale() {
  return !_lastFetched || Date.now() - _lastFetched > STALE_MS;
}
