/**
 * Test: Single Server URL Source-Scan Guard
 *
 * Verifies that:
 * 1. Only src/lib/api.js defines the backend server URL and its default.
 * 2. No competing/multiple defaults (e.g. 3001 vs 5000) exist across src/.
 * 3. In src/lib/api.js, the default http://localhost:5000 is used only in DEV,
 *    and a clear error is thrown if VITE_AI_SERVER_URL is unset in production.
 * 4. .env.example documents VITE_USE_EMULATOR and VITE_AI_SERVER_URL with names/example values.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const SRC_DIR = join(ROOT_DIR, 'src');
const ENV_EXAMPLE = join(ROOT_DIR, '.env.example');

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

describe('Single Server URL Source-Scan Guards', () => {
  it('Only src/lib/api.js defines the backend server URL or reads VITE_AI_SERVER_URL', () => {
    const files = walkFiles(SRC_DIR);
    for (const file of files) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, '/');
      if (rel === 'lib/api.js') continue;

      const content = readFileSync(file, 'utf8');
      assert.ok(
        !content.includes('VITE_AI_SERVER_URL'),
        `src/${rel} must not directly read VITE_AI_SERVER_URL; import SERVER_URL from src/lib/api.js instead`
      );
      assert.ok(
        !content.includes('VITE_SERVER_URL'),
        `src/${rel} contains deprecated VITE_SERVER_URL`
      );
    }
  });

  it('No two different server URL defaults exist across src/', () => {
    const files = walkFiles(SRC_DIR);
    const serverUrlRegex = /https?:\/\/localhost:(?:3000|3001|5000|5001|8000)/g;
    const defaultsFound = new Set();

    for (const file of files) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, '/');
      // Skip emulator connection ports in firebase.js
      if (rel === 'lib/firebase.js') continue;

      const content = readFileSync(file, 'utf8');
      const matches = content.match(serverUrlRegex);
      if (matches) {
        for (const m of matches) {
          defaultsFound.add(`${rel}: ${m}`);
        }
      }
    }

    // Only src/lib/api.js should have a server URL match (http://localhost:5000)
    assert.equal(
      defaultsFound.size,
      1,
      `Expected exactly one server URL default in src/, found: ${[...defaultsFound].join(', ')}`
    );
    assert.ok(
      [...defaultsFound][0].includes('lib/api.js: http://localhost:5000'),
      'The single default server URL must be http://localhost:5000 in src/lib/api.js'
    );
  });

  it('src/lib/api.js exports SERVER_URL, defaults in DEV only, and throws in production if unset', () => {
    const apiPath = join(SRC_DIR, 'lib', 'api.js');
    const content = readFileSync(apiPath, 'utf8');

    assert.ok(content.includes('export const SERVER_URL ='), 'src/lib/api.js must export SERVER_URL');
    assert.ok(content.includes('import.meta.env.DEV'), 'src/lib/api.js must check import.meta.env.DEV for default');
    assert.ok(content.includes("throw new Error("), 'src/lib/api.js must throw in production build when unset');
  });

  it('.env.example documents VITE_USE_EMULATOR and VITE_AI_SERVER_URL with names and example values', () => {
    assert.ok(existsSync(ENV_EXAMPLE), '.env.example must exist');
    const content = readFileSync(ENV_EXAMPLE, 'utf8');

    assert.ok(
      /^VITE_AI_SERVER_URL=/m.test(content),
      '.env.example must document VITE_AI_SERVER_URL'
    );
    assert.ok(
      /^VITE_USE_EMULATOR=/m.test(content),
      '.env.example must document VITE_USE_EMULATOR'
    );
  });
});
