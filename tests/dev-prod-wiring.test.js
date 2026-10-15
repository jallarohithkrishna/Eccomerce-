/**
 * Test: DEV/PROD Wiring Guard
 *
 * Verifies that:
 * 1. src/lib/firebase.js connects to emulators ONLY when import.meta.env.DEV is true
 *    AND import.meta.env.VITE_USE_EMULATOR === 'true'.
 * 2. No other files in src/ reference emulator ports (8080, 9099, 9199).
 * 3. Any production bundle in dist/ does not contain emulator hosts/ports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const SRC_DIR = join(ROOT_DIR, 'src');
const DIST_DIR = join(ROOT_DIR, 'dist');

function walkFiles(dir, exts = ['.js', '.jsx', '.ts', '.tsx']) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkFiles(full, exts));
    } else if (exts.includes(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

describe('DEV/PROD Wiring Guards', () => {
  it('src/lib/firebase.js guards emulator connections strictly with DEV and VITE_USE_EMULATOR === "true"', () => {
    const firebasePath = join(SRC_DIR, 'lib', 'firebase.js');
    const content = readFileSync(firebasePath, 'utf8');

    // Strict condition required
    const hasStrictGuard = content.includes("import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === 'true'");
    assert.ok(hasStrictGuard, 'src/lib/firebase.js must guard emulators with import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === \'true\'');

    // Must not contain loose/fallback conditions that enable emulator in dev without the flag
    const hasLooseDevFallback = content.includes("VITE_USE_EMULATOR !== 'false'");
    assert.ok(!hasLooseDevFallback, 'Must not have loose DEV fallback allowing emulators without explicit flag');
  });

  it('No files in src/ outside firebase.js reference emulator ports 8080, 9099, or 9199', () => {
    const files = walkFiles(SRC_DIR);
    const emulatorPortRegex = /\b(8080|9099|9199)\b/;

    for (const file of files) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, '/');
      if (rel === 'lib/firebase.js') continue;

      const content = readFileSync(file, 'utf8');
      const matches = content.match(emulatorPortRegex);
      assert.ok(
        !matches,
        `Unexpected emulator port found in src/${rel}: ${matches?.[0]}`
      );
    }
  });

  it('Production build in dist/ (if present) does not contain emulator connection hosts or ports', () => {
    if (!existsSync(DIST_DIR)) {
      return; // dist not built yet in this run, test passes conditionally
    }
    const distFiles = walkFiles(DIST_DIR, ['.js']);
    for (const file of distFiles) {
      const content = readFileSync(file, 'utf8');
      assert.ok(!content.includes('localhost:8080'), `dist file ${file} must not contain localhost:8080`);
      assert.ok(!content.includes('localhost:9099'), `dist file ${file} must not contain localhost:9099`);
      assert.ok(!content.includes('localhost:9199'), `dist file ${file} must not contain localhost:9199`);
    }
  });
});
