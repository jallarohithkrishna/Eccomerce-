import { auth } from './firebase';

const SERVER_URL = import.meta.env.VITE_AI_SERVER_URL || 'http://localhost:5000';

/**
 * Universal authenticated API fetch helper
 * Transparently attaches Bearer token from Firebase Auth
 */
export async function apiFetch(endpoint, options = {}) {
  let token = null;
  if (auth.currentUser) {
    try {
      token = await auth.currentUser.getIdToken();
    } catch (e) {
      console.warn('Failed to retrieve auth token:', e);
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const url = endpoint.startsWith('http') ? endpoint : `${SERVER_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers
  });

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}`;
    try {
      const errJson = await response.json();
      errorDetail = errJson.error || errJson.message || errorDetail;
    } catch {
      // ignore
    }
    throw new Error(errorDetail);
  }

  return response.json();
}
