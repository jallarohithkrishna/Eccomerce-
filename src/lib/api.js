import { auth } from './firebase';

const SERVER_URL = import.meta.env.VITE_AI_SERVER_URL || 'http://localhost:5000';

/**
 * Universal authenticated API fetch helper
 * Transparently attaches Bearer token from Firebase Auth.
 *
 * Options:
 *   rawResponse: true  — return the raw Response object (needed for SSE streams or FormData)
 *   All other options are passed to fetch().
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

  const { rawResponse, ...fetchOptions } = options;

  // Only set Content-Type for non-FormData bodies (browser sets it automatically for FormData)
  const isFormData = fetchOptions.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(fetchOptions.headers || {}),
  };

  const url = endpoint.startsWith('http') ? endpoint : `${SERVER_URL}${endpoint}`;
  const response = await fetch(url, {
    ...fetchOptions,
    headers,
  });

  // Caller wants raw response (e.g. SSE stream, FormData upload)
  if (rawResponse) {
    return response;
  }

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
