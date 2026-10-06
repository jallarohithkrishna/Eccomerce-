/**
 * Auth Middleware — verifyIdToken & requireRole
 * Verifies Firebase ID token and attaches decoded claims to req.user.
 */

import { getAuth } from 'firebase-admin/auth';

/**
 * Express middleware: verifies Bearer token and populates req.user.
 * Supports dev/test bypass headers (x-dev-uid, x-dev-role) in test or local dev mode.
 */
export async function verifyIdToken(req, res, next) {
  const header = req.headers.authorization || '';

  // Check dev/test bypass when no Bearer header is passed
  if (!header.startsWith('Bearer ')) {
    if (req.headers['x-dev-uid']) {
      const role = req.headers['x-dev-role'] || 'customer';
      req.user = {
        uid:         req.headers['x-dev-uid'],
        email:       req.headers['x-dev-email'] || 'test@example.com',
        role,
        isAdmin:     role === 'admin',
        isStaff:     role === 'staff',
        isWarehouse: role === 'warehouse',
      };
      return next();
    }
    return res.status(401).json({ error: 'Missing Bearer token' });
  }

  const token = header.slice(7);
  try {
    const decoded = await getAuth().verifyIdToken(token);
    req.user = {
      uid:         decoded.uid,
      email:       decoded.email,
      role:        decoded.role || 'customer',
      isAdmin:     decoded.role === 'admin',
      isStaff:     decoded.role === 'staff',
      isWarehouse: decoded.role === 'warehouse',
    };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token', detail: err.message });
  }
}

/**
 * Role-gating middleware: ensures authenticated user possesses at least one of the allowed roles.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const role = req.user.role || 'customer';
    if (!roles.includes(role)) {
      return res.status(403).json({ error: `Forbidden: requires one of [${roles.join(', ')}]` });
    }
    next();
  };
}
