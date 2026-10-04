/**
 * Automated guard: fails if any file in src/ contains a direct Firestore write
 * (updateDoc / setDoc / addDoc / deleteDoc) targeting orders, returns, refunds,
 * or products.
 *
 * Run with: node --test tests/no-client-writes.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(__dirname, "..", "src");

const WRITE_FN_RE = /\b(updateDoc|setDoc|addDoc|deleteDoc|writeBatch)\b/;

// Matches ONLY 2-arg top-level collection(db, 'X') — NOT subcollections
// ALLOWED:  collection(db, 'products', id, 'reviews')
// BLOCKED:  collection(db, 'products')
const TOP_LEVEL_COLLECTION_RE =
  /collection\(\s*\w+\s*,\s*['"`](orders|returns|refunds|products)['"`]\s*\)/;
// Matches doc(db, 'orders', ...) top-level doc writes
const TOP_LEVEL_DOC_RE =
  /doc\(\s*\w+\s*,\s*['"`](orders|returns|refunds|products)['"`]/;


function walkFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkFiles(full));
    } else if ([".js", ".jsx", ".ts", ".tsx"].includes(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

describe("No direct client-side Firestore writes on restricted collections", () => {
  const files = walkFiles(SRC_DIR);

  for (const file of files) {
    const rel = relative(SRC_DIR, file);
    it(`${rel} must not write to orders/returns/refunds/products`, () => {
      const source = readFileSync(file, "utf-8");
      if (!WRITE_FN_RE.test(source)) return;

      const lines = source.split("\n");
      const violations = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!WRITE_FN_RE.test(line)) continue;
        // Look in a ±3-line window for a restricted TOP-LEVEL collection/doc reference
        const window = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
        const cm = window.match(TOP_LEVEL_COLLECTION_RE);
        if (cm) violations.push(`Line ${i + 1}: write near top-level '${cm[1]}' collection`);
        const dm = window.match(TOP_LEVEL_DOC_RE);
        if (dm) violations.push(`Line ${i + 1}: doc(db, '${dm[1]}', ...) write`);
      }

      assert.deepEqual(
        violations,
        [],
        `${rel} contains direct client Firestore write(s) to restricted collections:\n  ${violations.join("\n  ")}`
      );
    });
  }
});
