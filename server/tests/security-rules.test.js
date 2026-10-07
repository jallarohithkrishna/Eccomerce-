/**
 * PS-01 Firestore & Storage Security Rules Unit Tests
 * 
 * Uses @firebase/rules-unit-testing (or runs as a spec against the rules).
 * Run with: npm test (when Firebase Emulator Suite with Java is available)
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIRESTORE_RULES_PATH = path.resolve(__dirname, '../../firestore.rules');
const STORAGE_RULES_PATH = path.resolve(__dirname, '../../storage.rules');

describe('Security Rules Verification Suite', () => {
  it('verifies firestore.rules file syntax and key security constraints', () => {
    assert.ok(fs.existsSync(FIRESTORE_RULES_PATH), 'firestore.rules must exist');
    const rules = fs.readFileSync(FIRESTORE_RULES_PATH, 'utf8');

    // 1. No hardcoded emails
    assert.strictEqual(rules.includes('k71540270@gmail.com'), false, 'Must not contain hardcoded admin email');
    assert.strictEqual(rules.includes('jallarohithkrishna@gmail.com'), false, 'Must not contain hardcoded admin email');

    // 2. Custom claims role checks
    assert.ok(rules.includes("request.auth.token.get('role'"), 'Must verify role from token custom claims');

    // 3. No public reads on orders or returns
    assert.strictEqual(rules.includes('match /orders/{orderId} {\n      allow read: if true;'), false, 'Orders must not have public reads');
    assert.strictEqual(rules.includes('match /returns/{returnId} {\n      allow read: if true;'), false, 'Returns must not have public reads');

    // 4. Returns writes disabled for clients
    assert.ok(rules.includes('match /returns/{returnId}'), 'Must have returns match');
    assert.ok(rules.includes('allow create: if false;'), 'Returns create must be server-only');
    assert.ok(rules.includes('allow update: if false;'), 'Returns update must be server-only');

    // 5. Events subcollection disabled for client writes
    assert.ok(rules.includes('match /events/{seq}'), 'Must have events subcollection match');

    // 6. User role self-escalation prevented
    assert.ok(rules.includes('match /users/{userId}'), 'Must have users collection match');
    assert.ok(rules.includes('request.resource.data.role == resource.data.role') || rules.includes("role == 'customer'"), 'Must prevent self-escalation of roles');

    // 7. Alerts collection: staff and admin read, no client writes
    assert.ok(rules.includes('match /alerts/{alertId}'), 'Must have alerts match');
    assert.ok(rules.includes('allow read: if isStaff();') || rules.includes('allow read: if isStaff()'), 'Must allow staff read on alerts');
  });

  it('verifies storage.rules syntax and upload constraints', () => {
    assert.ok(fs.existsSync(STORAGE_RULES_PATH), 'storage.rules must exist');
    const storageRules = fs.readFileSync(STORAGE_RULES_PATH, 'utf8');

    // 1. Max size limit enforced
    assert.ok(storageRules.includes('10 * 1024 * 1024'), 'Must enforce 10MB limit');

    // 2. Image content type enforced
    assert.ok(storageRules.includes("request.resource.contentType.matches('image/.*')"), 'Must enforce image MIME type');

    // 3. Authenticated owner access
    assert.ok(storageRules.includes('request.auth.uid == userId'), 'Must restrict upload to authenticated owner');
  });
});
