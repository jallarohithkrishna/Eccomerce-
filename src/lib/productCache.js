/**
 * Module-level in-memory product cache.
 * Lives in JS module scope — survives React re-renders and route changes.
 * Implements stale-while-revalidate: instant reads + background refresh.
 */
import { db } from './firebase';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';

// ─── Cache State ──────────────────────────────────────────────────────────────
let _products = [];
let _productMap = {};   // id → product  (O(1) lookup)
let _lastFetched = null;
let _unsubscribe = null;
let _listeners = new Set();
let _initialized = false;

const STALE_MS = 5 * 60 * 1000; // 5 minutes

// ─── Notify all subscribers ───────────────────────────────────────────────────
function _notify() {
  _listeners.forEach(fn => fn(_products));
}

// ─── Start the real-time listener (called once) ───────────────────────────────
function _startListener() {
  if (_unsubscribe) return; // already listening
  const q = query(collection(db, 'products'), orderBy('created_at', 'desc'));
  _unsubscribe = onSnapshot(q, (snap) => {
    _products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _productMap = Object.fromEntries(_products.map(p => [p.id, p]));
    _lastFetched = Date.now();
    _initialized = true;
    _notify();
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Subscribe to product list changes.
 * Immediately calls `callback` with cached data (may be empty on first call),
 * then calls it again whenever Firestore pushes an update.
 *
 * @param {(products: Array) => void} callback
 * @returns {() => void}  unsubscribe function
 */
export function subscribeToProducts(callback) {
  _listeners.add(callback);

  // Start the real-time listener on first subscriber
  _startListener();

  // Immediately emit whatever we already have (instant render)
  callback(_products);

  return () => {
    _listeners.delete(callback);
    // Stop the Firestore listener only when nobody is subscribed
    if (_listeners.size === 0 && _unsubscribe) {
      _unsubscribe();
      _unsubscribe = null;
    }
  };
}

/**
 * Get the current cached product list synchronously.
 * Returns [] if cache hasn't been populated yet.
 */
export function getCachedProducts() {
  return _products;
}

/**
 * Get a single product by ID instantly from cache.
 * Returns `null` if not in cache yet.
 *
 * @param {string} id
 * @returns {object|null}
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
