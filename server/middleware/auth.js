/**
 * Auth Middleware — verifyIdToken
 * Verifies Firebase ID token and attaches decoded claims to req.user.
 */

import { getAuth } from 'firebase-admin/auth';

/**
 * Express middleware: verifies Bearer token and populates req.user.
 * Rejects with 401 if missing, 403 if invalid/expired.
 */
export async function verifyIdToken(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
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
