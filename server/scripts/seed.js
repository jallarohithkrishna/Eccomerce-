#!/usr/bin/env node

/**
 * PS-01 Database & Auth Seed Script — Phase C4
 *
 * Seeds ~50 orders and 10 products with realistic return policies.
 * Creates Firebase Auth emulator users with custom claims:
 *   - customer A, customer B, staff, warehouse, admin
 * Sets delivered_at to different ages (inside & outside policy windows):
 *   - Fashion item defective & in-window
 *   - Expired fashion item
 *   - Beauty item (hygiene seal, replacement only)
 *   - Electronics item (service-center only)
 *   - Grocery item (non-returnable perishable)
 *   - Luxury item at ₹60,000 (triggers HUMAN_REVIEW)
 *   - Undelivered order (in transit / processing)
 *
 * Idempotency:
 *   Refuses a second run unless --force is specified.
 *
 * Environment Target:
 *   Defaults to Firebase Emulator (127.0.0.1:8080 / 127.0.0.1:9099).
 *   Only targets production/live project when --live flag is passed explicitly.
 *
 * Usage:
 *   node server/scripts/seed.js           # Seeds emulator (default)
 *   node server/scripts/seed.js --force   # Overwrites / re-seeds emulator
 *   node server/scripts/seed.js --live    # Targets live project (refuses without credentials)
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

// ─── 10 Seed Products ────────────────────────────────────────────────────────

export const SEED_PRODUCTS = [
  {
    id: 'prod_fashion_shirt',
    name: 'Slim Fit Cotton Casual Shirt',
    category: 'fashion',
    price: 1499,
    stock_quantity: 120,
    rating: 4.5,
    review_count: 88,
    image_url: 'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&q=80&w=400',
    description: '100% breathable organic cotton shirt with reinforced seams.',
    return_policy: {
      eligible: true,
      window_days: 14,
      policy_type: 'full_refund_or_exchange',
      title: '14-Day Fashion Return Policy',
      requires_photo_evidence: false,
      tags_must_be_attached: true,
      allowed_resolutions: ['refund', 'exchange', 'store_credit'],
    },
  },
  {
    id: 'prod_fashion_jacket',
    name: 'Vintage Wash Denim Jacket',
    category: 'fashion',
    price: 3499,
    stock_quantity: 65,
    rating: 4.7,
    review_count: 142,
    image_url: 'https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&q=80&w=400',
    description: 'Heavyweight vintage denim with classic brass button hardware.',
    return_policy: {
      eligible: true,
      window_days: 14,
      policy_type: 'full_refund_or_exchange',
      title: '14-Day Fashion Return Policy',
      requires_photo_evidence: false,
      tags_must_be_attached: true,
      allowed_resolutions: ['refund', 'exchange', 'store_credit'],
    },
  },
  {
    id: 'prod_beauty_serum',
    name: 'Vitamin C Radiance Face Serum (30ml)',
    category: 'beauty',
    price: 999,
    stock_quantity: 200,
    rating: 4.8,
    review_count: 310,
    image_url: 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?auto=format&fit=crop&q=80&w=400',
    description: 'Antioxidant brightening serum. Hygiene sealed for safety.',
    return_policy: {
      eligible: true,
      window_days: 7,
      policy_type: 'replacement_only',
      title: '7-Day Replacement Only (Hygiene Sensitive)',
      requires_photo_evidence: true,
      seal_must_be_intact: true,
      allowed_resolutions: ['replacement'],
    },
  },
  {
    id: 'prod_elec_headphones',
    name: 'Wireless Active Noise Cancelling Headphones',
    category: 'electronics',
    price: 4999,
    stock_quantity: 45,
    rating: 4.6,
    review_count: 220,
    image_url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&q=80&w=400',
    description: 'High-res audio, 40h battery life, service-center warranty.',
    return_policy: {
      eligible: false,
      window_days: 7,
      policy_type: 'service_center_only',
      title: 'Brand Authorized Service Center Only',
      service_center_required: true,
      requires_photo_evidence: true,
      allowed_resolutions: [],
    },
  },
  {
    id: 'prod_groc_coffee',
    name: 'Single Origin Arabica Coffee Beans (500g)',
    category: 'groceries',
    price: 650,
    stock_quantity: 150,
    rating: 4.9,
    review_count: 95,
    image_url: 'https://images.unsplash.com/photo-1559056199-641a0ac8b55e?auto=format&fit=crop&q=80&w=400',
    description: 'Medium roast freshly packed specialty beans. Perishable item.',
    return_policy: {
      eligible: false,
      window_days: 0,
      policy_type: 'non_returnable',
      title: 'Non-Returnable (Perishable Grocery Item)',
      damage_exception: true,
      damage_window_hours: 24,
      requires_photo_evidence: true,
      allowed_resolutions: ['refund', 'replacement'],
    },
  },
  {
    id: 'prod_lux_watch',
    name: 'Heritage Chronograph Automatic Gold Watch',
    category: 'luxury',
    price: 60000,
    stock_quantity: 8,
    rating: 5.0,
    review_count: 14,
    image_url: 'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&q=80&w=400',
    description: 'Swiss movement luxury timepiece. Serialized authenticity certificate included.',
    return_policy: {
      eligible: true,
      window_days: 10,
      policy_type: 'full_refund_or_replacement',
      title: 'High-Value Luxury Return (Human Review Mandatory)',
      high_value_threshold: 50000,
      authenticity_cards_required: true,
      original_packaging_required: true,
      allowed_resolutions: ['refund', 'replacement'],
    },
  },
  {
    id: 'prod_lux_bag',
    name: 'Artisan Full Grain Italian Leather Bag',
    category: 'luxury',
    price: 55000,
    stock_quantity: 12,
    rating: 4.9,
    review_count: 22,
    image_url: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&q=80&w=400',
    description: 'Handcrafted luxury leather travel bag with serial tag.',
    return_policy: {
      eligible: true,
      window_days: 10,
      policy_type: 'full_refund_or_replacement',
      title: 'Luxury Leather Return Policy',
      high_value_threshold: 50000,
      authenticity_cards_required: true,
      allowed_resolutions: ['refund', 'replacement'],
    },
  },
  {
    id: 'prod_home_lamp',
    name: 'Nordic Ceramic Dimmable Table Lamp',
    category: 'home',
    price: 2199,
    stock_quantity: 80,
    rating: 4.4,
    review_count: 64,
    image_url: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&q=80&w=400',
    description: 'Modern ceramic ambient lighting with warm dimming LED bulb.',
    return_policy: {
      eligible: true,
      window_days: 15,
      policy_type: 'full_refund_or_replacement',
      title: '15-Day Home Goods Return Policy',
      all_parts_required: true,
      allowed_resolutions: ['refund', 'replacement'],
    },
  },
  {
    id: 'prod_elec_smartwatch',
    name: 'Ultra AMOLED GPS Fitness Smartwatch',
    category: 'electronics',
    price: 3999,
    stock_quantity: 70,
    rating: 4.3,
    review_count: 175,
    image_url: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&q=80&w=400',
    description: 'SpO2 sensor, heart rate tracking, authorized service center coverage.',
    return_policy: {
      eligible: false,
      window_days: 7,
      policy_type: 'service_center_only',
      title: 'Electronics Service Center Warranty',
      service_center_required: true,
      requires_photo_evidence: true,
      allowed_resolutions: [],
    },
  },
  {
    id: 'prod_fashion_sneakers',
    name: 'All-Day Comfort Low-Top Canvas Sneakers',
    category: 'fashion',
    price: 2299,
    stock_quantity: 90,
    rating: 4.6,
    review_count: 118,
    image_url: 'https://images.unsplash.com/photo-1525966222134-fcfa99b8ae77?auto=format&fit=crop&q=80&w=400',
    description: 'Cushioned vulcanized rubber sole with breathable cotton canvas.',
    return_policy: {
      eligible: true,
      window_days: 14,
      policy_type: 'full_refund_or_exchange',
      title: '14-Day Footwear Return Policy',
      tags_must_be_attached: true,
      must_be_unwashed_unworn: true,
      allowed_resolutions: ['refund', 'exchange', 'store_credit'],
    },
  },
];

// ─── Demo Users ──────────────────────────────────────────────────────────────

export const DEMO_USERS = [
  {
    uid: 'demo_cust_a',
    email: 'customera@example.com',
    password: 'Password123!',
    displayName: 'Customer Alice',
    role: 'customer',
  },
  {
    uid: 'demo_cust_b',
    email: 'customerb@example.com',
    password: 'Password123!',
    displayName: 'Customer Bob',
    role: 'customer',
  },
  {
    uid: 'demo_staff_01',
    email: 'staff@example.com',
    password: 'Password123!',
    displayName: 'Support Staff',
    role: 'staff',
  },
  {
    uid: 'demo_wh_01',
    email: 'warehouse@example.com',
    password: 'Password123!',
    displayName: 'Warehouse Agent',
    role: 'warehouse',
  },
  {
    uid: 'demo_admin_01',
    email: 'admin@example.com',
    password: 'Password123!',
    displayName: 'Store Admin',
    role: 'admin',
  },
];

// ─── Generate 50 Seed Orders ─────────────────────────────────────────────────

export function buildSeedOrders() {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const userA = DEMO_USERS[0];
  const userB = DEMO_USERS[1];

  const pShirt    = SEED_PRODUCTS[0];
  const pJacket   = SEED_PRODUCTS[1];
  const pSerum    = SEED_PRODUCTS[2];
  const pPhones   = SEED_PRODUCTS[3];
  const pCoffee   = SEED_PRODUCTS[4];
  const pWatch    = SEED_PRODUCTS[5];
  const pBag      = SEED_PRODUCTS[6];
  const pLamp     = SEED_PRODUCTS[7];
  const pSmart    = SEED_PRODUCTS[8];
  const pSneakers = SEED_PRODUCTS[9];

  const orders = [
    // 1. Fashion item defective & inside window (delivered 2 days ago)
    {
      id: 'ORD-FASHION-DEFECTIVE-IN-WIN',
      order_number: 'ORD-2026-0001',
      customer: {
        user_id: userA.uid,
        email: userA.email,
        full_name: userA.displayName,
        address: '104 Magnolia Blvd, Koramangala, Bengaluru, Karnataka 560034',
        phone: '+91 98765 43210',
      },
      status: 'delivered',
      delivered_at: new Date(now - 2 * DAY_MS).toISOString(),
      created_at: new Date(now - 6 * DAY_MS).toISOString(),
      updated_at: new Date(now - 2 * DAY_MS).toISOString(),
      items: [
        {
          product_id: pShirt.id,
          name: pShirt.name,
          price: pShirt.price,
          quantity: 1,
          category: pShirt.category,
          image_url: pShirt.image_url,
        },
      ],
      total_amount: pShirt.price,
      currency: 'INR',
    },

    // 2. Expired fashion item (delivered 35 days ago; 14-day window expired)
    {
      id: 'ORD-FASHION-EXPIRED',
      order_number: 'ORD-2026-0002',
      customer: {
        user_id: userA.uid,
        email: userA.email,
        full_name: userA.displayName,
        address: '104 Magnolia Blvd, Koramangala, Bengaluru, Karnataka 560034',
        phone: '+91 98765 43210',
      },
      status: 'delivered',
      delivered_at: new Date(now - 35 * DAY_MS).toISOString(),
      created_at: new Date(now - 39 * DAY_MS).toISOString(),
      updated_at: new Date(now - 35 * DAY_MS).toISOString(),
      items: [
        {
          product_id: pJacket.id,
          name: pJacket.name,
          price: pJacket.price,
          quantity: 1,
          category: pJacket.category,
          image_url: pJacket.image_url,
        },
      ],
      total_amount: pJacket.price,
      currency: 'INR',
    },

    // 3. Beauty item (hygiene seal / replacement only, photo evidence required)
    {
      id: 'ORD-BEAUTY-IN-WIN',
      order_number: 'ORD-2026-0003',
      customer: {
        user_id: userA.uid,
        email: userA.email,
        full_name: userA.displayName,
        address: '104 Magnolia Blvd, Koramangala, Bengaluru, Karnataka 560034',
        phone: '+91 98765 43210',
      },
      status: 'delivered',
      delivered_at: new Date(now - 3 * DAY_MS).toISOString(),
      created_at: new Date(now - 7 * DAY_MS).toISOString(),
      updated_at: new Date(now - 3 * DAY_MS).toISOString(),
      items: [
        {
          product_id: pSerum.id,
          name: pSerum.name,
          price: pSerum.price,
          quantity: 1,
          category: pSerum.category,
          image_url: pSerum.image_url,
        },
      ],
      total_amount: pSerum.price,
      currency: 'INR',
    },

    // 4. Electronics item (service-center only, direct return refused)
    {
      id: 'ORD-ELEC-SERVICE-CENTER',
      order_number: 'ORD-2026-0004',
      customer: {
        user_id: userB.uid,
        email: userB.email,
        full_name: userB.displayName,
        address: '42 Orchid Heights, Indiranagar, Bengaluru, Karnataka 560038',
        phone: '+91 91234 56789',
      },
      status: 'delivered',
      delivered_at: new Date(now - 4 * DAY_MS).toISOString(),
      created_at: new Date(now - 8 * DAY_MS).toISOString(),
      updated_at: new Date(now - 4 * DAY_MS).toISOString(),
      items: [
        {
          product_id: pPhones.id,
          name: pPhones.name,
          price: pPhones.price,
          quantity: 1,
          category: pPhones.category,
          image_url: pPhones.image_url,
        },
      ],
      total_amount: pPhones.price,
      currency: 'INR',
    },

    // 5. Grocery item (non-returnable perishable food)
    {
      id: 'ORD-GROC-PERISHABLE',
      order_number: 'ORD-2026-0005',
      customer: {
        user_id: userB.uid,
        email: userB.email,
        full_name: userB.displayName,
        address: '42 Orchid Heights, Indiranagar, Bengaluru, Karnataka 560038',
        phone: '+91 91234 56789',
      },
      status: 'delivered',
      delivered_at: new Date(now - 1 * DAY_MS).toISOString(),
      created_at: new Date(now - 3 * DAY_MS).toISOString(),
      updated_at: new Date(now - 1 * DAY_MS).toISOString(),
      items: [
        {
          product_id: pCoffee.id,
          name: pCoffee.name,
          price: pCoffee.price,
          quantity: 2,
          category: pCoffee.category,
          image_url: pCoffee.image_url,
        },
      ],
      total_amount: pCoffee.price * 2,
      currency: 'INR',
    },

    // 6. Luxury item at ₹60,000 (triggers HUMAN_REVIEW due to > ₹50,000 threshold)
    {
      id: 'ORD-LUX-60K-HUMAN-REVIEW',
      order_number: 'ORD-2026-0006',
      customer: {
        user_id: userA.uid,
        email: userA.email,
        full_name: userA.displayName,
        address: '104 Magnolia Blvd, Koramangala, Bengaluru, Karnataka 560034',
        phone: '+91 98765 43210',
      },
      status: 'delivered',
      delivered_at: new Date(now - 2 * DAY_MS).toISOString(),
      created_at: new Date(now - 5 * DAY_MS).toISOString(),
      updated_at: new Date(now - 2 * DAY_MS).toISOString(),
      items: [
        {
          product_id: pWatch.id,
          name: pWatch.name,
          price: pWatch.price,
          quantity: 1,
          category: pWatch.category,
          image_url: pWatch.image_url,
        },
      ],
      total_amount: pWatch.price,
      currency: 'INR',
    },

    // 7. Not yet delivered (shipped / processing, delivered_at is undefined)
    {
      id: 'ORD-UNDELIVERED-ACTIVE',
      order_number: 'ORD-2026-0007',
      customer: {
        user_id: userB.uid,
        email: userB.email,
        full_name: userB.displayName,
        address: '42 Orchid Heights, Indiranagar, Bengaluru, Karnataka 560038',
        phone: '+91 91234 56789',
      },
      status: 'shipped',
      delivered_at: null,
      created_at: new Date(now - 1 * DAY_MS).toISOString(),
      updated_at: new Date(now - 1 * DAY_MS).toISOString(),
      items: [
        {
          product_id: pSneakers.id,
          name: pSneakers.name,
          price: pSneakers.price,
          quantity: 1,
          category: pSneakers.category,
          image_url: pSneakers.image_url,
        },
      ],
      total_amount: pSneakers.price,
      currency: 'INR',
    },
  ];

  // Additional 43 orders to reach total 50
  const productCatalog = [pShirt, pJacket, pSerum, pPhones, pCoffee, pBag, pLamp, pSmart, pSneakers];

  for (let i = 8; i <= 50; i++) {
    const isUserA = i % 2 === 0;
    const cust = isUserA ? userA : userB;
    const prod = productCatalog[(i - 8) % productCatalog.length];
    const ageDays = (i * 3) % 45; // Varying delivery ages 0..45 days
    const isDelivered = i % 15 !== 0; // Occasionally undelivered

    const deliveredAt = isDelivered ? new Date(now - ageDays * DAY_MS).toISOString() : null;
    const createdAt = new Date(now - (ageDays + 3) * DAY_MS).toISOString();

    orders.push({
      id: `ORD-2026-${String(i).padStart(4, '0')}`,
      order_number: `ORD-2026-${String(i).padStart(4, '0')}`,
      customer: {
        user_id: cust.uid,
        email: cust.email,
        full_name: cust.displayName,
        address: isUserA
          ? '104 Magnolia Blvd, Koramangala, Bengaluru, Karnataka 560034'
          : '42 Orchid Heights, Indiranagar, Bengaluru, Karnataka 560038',
        phone: isUserA ? '+91 98765 43210' : '+91 91234 56789',
      },
      status: isDelivered ? 'delivered' : 'processing',
      delivered_at: deliveredAt,
      created_at: createdAt,
      updated_at: deliveredAt || createdAt,
      items: [
        {
          product_id: prod.id,
          name: prod.name,
          price: prod.price,
          quantity: 1,
          category: prod.category,
          image_url: prod.image_url,
        },
      ],
      total_amount: prod.price,
      currency: 'INR',
    });
  }

  return orders;
}

// ─── Main Seed Execution Function ─────────────────────────────────────────────

export async function seedDatabase({ db, auth, isForce = false, isLive = false } = {}) {
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('                      NOVA STORE DATABASE SEED RUNNER                          ');
  console.log(`  Target:       ${isLive ? '🔴 LIVE PRODUCTION PROJECT' : '🟢 FIREBASE EMULATOR (Local)'}`);
  console.log(`  Force Mode:   ${isForce ? 'YES (Overwrite)' : 'NO (Idempotent Guard)'}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // 1. Idempotency Check: Refuse second run unless --force
  const seedMarkerRef = db.collection('_meta').doc('seed');
  const existingMarker = await seedMarkerRef.get();

  if (existingMarker.exists && !isForce) {
    const data = existingMarker.data();
    console.log(`⚠️  [IDEMPOTENT GUARD] Database was already seeded at ${data?.seededAt || 'earlier date'}.`);
    console.log('   Second execution refused to prevent overwriting demo data.');
    console.log('   Run with `--force` flag if you explicitly want to re-seed.\n');
    return {
      status: 'SKIPPED_ALREADY_SEEDED',
      seededAt: data?.seededAt,
      ordersCount: data?.ordersCount,
      productsCount: data?.productsCount,
    };
  }

  // 2. Seed Auth Users
  console.log('👤 Seeding Firebase Auth Users with Custom Claims...');
  for (const u of DEMO_USERS) {
    if (auth) {
      try {
        let userRec;
        try {
          userRec = await auth.getUserByEmail(u.email);
          await auth.updateUser(userRec.uid, {
            displayName: u.displayName,
            password: u.password,
          });
        } catch (notFound) {
          userRec = await auth.createUser({
            uid: u.uid,
            email: u.email,
            password: u.password,
            displayName: u.displayName,
            emailVerified: true,
          });
        }

        // Set custom user claim role
        await auth.setCustomUserClaims(userRec.uid, { role: u.role });
        console.log(`  ✓ Auth user: ${u.email} [${u.role}] (uid: ${userRec.uid})`);
      } catch (authErr) {
        console.warn(`  ⚠️ Auth creation note (${u.email}): ${authErr.message}`);
      }
    }

    // Sync into Firestore 'users' collection
    await db.collection('users').doc(u.uid).set(
      {
        uid: u.uid,
        email: u.email,
        role: u.role,
        full_name: u.displayName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { merge: true }
    );
  }

  // 3. Seed Products
  console.log('\n📦 Seeding 10 Products with Category Return Policies...');
  for (const prod of SEED_PRODUCTS) {
    await db.collection('products').doc(prod.id).set(
      {
        ...prod,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { merge: true }
    );
  }
  console.log(`  ✓ Seeded ${SEED_PRODUCTS.length} products into 'products' collection.`);

  // 4. Seed Orders
  const orders = buildSeedOrders();
  console.log(`\n🛍️  Seeding ${orders.length} Orders across varying delivered_at ages...`);
  for (const ord of orders) {
    await db.collection('orders').doc(ord.id).set(ord, { merge: true });
  }
  console.log(`  ✓ Seeded ${orders.length} orders into 'orders' collection.`);

  // 5. Write Seed Marker Doc for Idempotency
  await seedMarkerRef.set({
    seededAt: new Date().toISOString(),
    isLive,
    productsCount: SEED_PRODUCTS.length,
    ordersCount: orders.length,
    usersCount: DEMO_USERS.length,
    version: '1.0',
  });

  // 6. Print Demo Logins Table
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('                          DEMO LOGIN CREDENTIALS                               ');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' Role        Email                    Password        Purpose');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  DEMO_USERS.forEach((u) => {
    const rolePadded = u.role.padEnd(11, ' ');
    const emailPadded = u.email.padEnd(24, ' ');
    const purpose =
      u.role === 'customer'
        ? 'Customer portal & AI returns'
        : u.role === 'staff'
        ? 'Customer support & appeals'
        : u.role === 'warehouse'
        ? 'Intake receipt & item inspection'
        : 'Store configuration & admin queue';
    console.log(` ${rolePadded} ${emailPadded} ${u.password.padEnd(15, ' ')} ${purpose}`);
  });
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  return {
    status: 'SEEDED_SUCCESSFULLY',
    ordersCount: orders.length,
    productsCount: SEED_PRODUCTS.length,
    usersCount: DEMO_USERS.length,
  };
}

// ─── Direct CLI Execution ─────────────────────────────────────────────────────

async function cli() {
  const args = process.argv.slice(2);
  const isLive = args.includes('--live');
  const isForce = args.includes('--force');

  if (!isLive) {
    // Emulator by default
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
  } else {
    // Live project explicit check
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    console.log('⚠️ Running in LIVE mode against cloud Firebase.');
  }

  if (getApps().length === 0) {
    const explicitKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.resolve(__dirname, '../../serviceAccountKey.json');
    if (fs.existsSync(explicitKeyPath)) {
      const sa = JSON.parse(fs.readFileSync(explicitKeyPath, 'utf8'));
      initializeApp({ credential: cert(sa) });
    } else {
      const projectId = process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'demo-novastore';
      initializeApp({ projectId });
    }
  }

  const db = getFirestore();
  const auth = getAuth();

  await seedDatabase({ db, auth, isForce, isLive });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal seeding error:', err);
      process.exit(1);
    });
}
