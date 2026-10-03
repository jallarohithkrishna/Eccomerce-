#!/usr/bin/env node

/**
 * PS-01 Role Assignment CLI
 * Sets Firebase Auth custom user claims (role: 'customer' | 'staff' | 'admin' | 'warehouse')
 *
 * Usage:
 *   node server/scripts/set-role.js --email user@example.com --role admin
 *   node server/scripts/set-role.js --uid <firebase_uid> --role warehouse
 *   node server/scripts/set-role.js --list <email_or_uid>
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const VALID_ROLES = ['customer', 'staff', 'admin', 'warehouse'];

// Initialize Firebase Admin
function initFirebaseAdmin() {
  if (getApps().length > 0) return;

  const explicitKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.resolve(__dirname, '../../serviceAccountKey.json');
  if (fs.existsSync(explicitKeyPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(explicitKeyPath, 'utf8'));
    initializeApp({ credential: cert(serviceAccount) });
    return;
  }

  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'rrrrr-711b3';
  initializeApp({ projectId });
}

async function main() {
  const args = process.argv.slice(2);
  let email = null;
  let uid = null;
  let role = null;
  let isList = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) email = args[++i];
    else if (args[i] === '--uid' && args[i + 1]) uid = args[++i];
    else if (args[i] === '--role' && args[i + 1]) role = args[++i].toLowerCase();
    else if (args[i] === '--list' && args[i + 1]) {
      const target = args[++i];
      if (target.includes('@')) email = target;
      else uid = target;
      isList = true;
    }
  }

  if ((!email && !uid) || (!isList && !role)) {
    console.log(`
PS-01 Role Assignment Tool (Firebase Auth Custom Claims)
-------------------------------------------------------
Usage:
  node server/scripts/set-role.js --email <email> --role <customer|staff|admin|warehouse>
  node server/scripts/set-role.js --uid <uid> --role <customer|staff|admin|warehouse>
  node server/scripts/set-role.js --list <email_or_uid>

Available Roles: ${VALID_ROLES.join(', ')}
    `);
    process.exit(1);
  }

  if (role && !VALID_ROLES.includes(role)) {
    console.error(`❌ Error: Invalid role "${role}". Allowed roles: ${VALID_ROLES.join(', ')}`);
    process.exit(1);
  }

  initFirebaseAdmin();
  const auth = getAuth();
  const db = getFirestore();

  try {
    let targetUser;
    if (email) {
      targetUser = await auth.getUserByEmail(email);
    } else {
      targetUser = await auth.getUser(uid);
    }

    if (isList) {
      console.log(`User: ${targetUser.email} (UID: ${targetUser.uid})`);
      console.log(`Custom Claims:`, JSON.stringify(targetUser.customClaims || {}, null, 2));
      return;
    }

    // Set custom claims
    const updatedClaims = {
      ...(targetUser.customClaims || {}),
      role
    };

    await auth.setCustomUserClaims(targetUser.uid, updatedClaims);

    // Sync role to users collection document in Firestore
    try {
      await db.collection('users').doc(targetUser.uid).set(
        { role, updated_at: new Date().toISOString() },
        { merge: true }
      );
    } catch (dbErr) {
      console.warn(`⚠️ Warning: Could not update Firestore users doc: ${dbErr.message}`);
    }

    console.log(`✅ Successfully set role "${role}" for user ${targetUser.email} (${targetUser.uid})`);
  } catch (error) {
    console.error(`❌ Failed to set role: ${error.message}`);
    process.exit(1);
  }
}

main();
