/**
 * stripUndefined — Recursively strips undefined keys from objects and arrays.
 * Preserves null, false, 0, empty strings, and dates.
 * Essential for Firestore Admin writes where ignoreUndefinedProperties might not be set.
 */
export function stripUndefined(val) {
  if (val === undefined) return undefined;
  if (val === null || typeof val !== 'object') return val;
  if (val instanceof Date) return val;

  if (Array.isArray(val)) {
    return val
      .filter(item => item !== undefined)
      .map(item => stripUndefined(item));
  }

  const clean = {};
  for (const [k, v] of Object.entries(val)) {
    if (v !== undefined) {
      const cleaned = stripUndefined(v);
      if (cleaned !== undefined) {
        clean[k] = cleaned;
      }
    }
  }
  return clean;
}
