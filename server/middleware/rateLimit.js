/**
 * Rate Limiter — per-user sliding window
 * In-memory. For production, use Redis or Firestore-backed store.
 * Default: 20 requests / 60 seconds per uid.
 */

/** @type {Map<string, {count: number, windowStart: number}>} */
const windows = new Map();

/**
 * Express middleware factory.
 * @param {Object} opts
 * @param {number} [opts.max]      - Max requests per window (default 20)
 * @param {number} [opts.windowMs] - Window in ms (default 60000)
 */
export function rateLimit({ max = 20, windowMs = 60_000 } = {}) {
  return (req, res, next) => {
    const uid = req.user?.uid || req.ip || 'anon';
    const now = Date.now();

    let entry = windows.get(uid);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 0, windowStart: now };
    }
    entry.count++;
    windows.set(uid, entry);

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `Rate limit exceeded. Max ${max} requests per ${windowMs / 1000}s. Retry after ${retryAfter}s.`,
      });
    }
    next();
  };
}

/** For tests: clear all windows. */
export function _clearWindows() { windows.clear(); }
