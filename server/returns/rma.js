/**
 * RMA number generation — PS-01 Phase 4b
 *
 * RMA numbers are the only key accepted by the public
 * GET /returns/verify/:identifier endpoint, so they must not be guessable.
 * Previously they were `Date.now().toString(36)` — a raw timestamp that anyone
 * could enumerate. They are now 12 cryptographically random characters from a
 * 32-symbol ambiguous-free alphabet (32 divides 256, so `byte % 32` is uniform).
 */

import { randomBytes } from 'node:crypto';

/** No I/O/0/O/1 — 32 symbols, 5 bits each. */
export const RMA_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Minimum number of random characters after the `RMA-` prefix. */
export const RMA_RANDOM_LENGTH = 12;

/** Structural test for a well-formed, unguessable RMA number. */
export const RMA_PATTERN = new RegExp(`^RMA-[${RMA_ALPHABET}]{${RMA_RANDOM_LENGTH},}$`);

/**
 * Mint a fresh RMA number.
 * @param {number} [length] - number of random characters (>= RMA_RANDOM_LENGTH)
 * @returns {string} e.g. `RMA-7KQ4M2XW9PZT`
 */
export function generateRma(length = RMA_RANDOM_LENGTH) {
  const n = Math.max(length, RMA_RANDOM_LENGTH);
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) {
    out += RMA_ALPHABET[bytes[i] % RMA_ALPHABET.length];
  }
  return `RMA-${out}`;
}
