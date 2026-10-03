import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, updateDoc } from 'firebase/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env
const envPath = path.resolve(__dirname, '../.env');
const envText = fs.readFileSync(envPath, 'utf-8');
const env = {};
envText.split('\n').forEach(line => {
  const [k, ...v] = line.split('=');
  if (k && v) env[k.trim()] = v.join('=').trim();
});

const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID
});

const db = getFirestore(app);

export function getReturnPolicyForCategory(category = '') {
  const cat = (category || '').toLowerCase().trim();

  if (['groceries'].includes(cat)) {
    return {
      eligible: false,
      window_days: 0,
      policy_type: 'non_returnable',
      title: 'Non-Returnable (Perishable Food Item)',
      description: 'Perishable food and grocery items cannot be returned due to food safety and hygiene regulations. If item arrived damaged or spoiled, report within 24 hours for instant refund or replacement.',
      conditions: [
        'Report within 24 hours of delivery',
        'Photo evidence of damage/spoilage required'
      ],
      restocking_fee_percent: 0,
      requires_photo_evidence: true
    };
  }

  if (['beauty', 'fragrances', 'skin-care'].includes(cat)) {
    return {
      eligible: true,
      window_days: 7,
      policy_type: 'replacement_only',
      title: '7-Day Replacement Only (Hygiene Sensitive)',
      description: 'Eligible for replacement within 7 days only if arrived damaged, defective, or with broken seal. Opened or used personal care items are strictly non-returnable.',
      conditions: [
        'Factory hygiene seal must be intact',
        'Photo proof required if leaked or damaged in transit',
        'Replacement dispatched upon return approval'
      ],
      restocking_fee_percent: 0,
      requires_photo_evidence: true
    };
  }

  if (['smartphones', 'laptops', 'tablets'].includes(cat)) {
    return {
      eligible: true,
      window_days: 7,
      policy_type: 'replacement_or_repair',
      title: '7-Day Brand Replacement & Warranty',
      description: 'Eligible for free replacement within 7 days if defective or transit-damaged. Requires original brand box with matching IMEI/Serial and all accessories.',
      conditions: [
        'Original box and IMEI/Serial must match',
        'All inbox accessories and chargers included',
        'Device unlinked from personal accounts/PIN locks'
      ],
      restocking_fee_percent: 0,
      requires_photo_evidence: true
    };
  }

  if (['mobile-accessories'].includes(cat)) {
    return {
      eligible: true,
      window_days: 10,
      policy_type: 'full_refund_or_replacement',
      title: '10-Day Return & Replacement',
      description: 'Return or replace within 10 days of delivery. Covers defective cables, chargers, cases, and audio accessories.',
      conditions: [
        'Original retail packaging and cords included',
        'No signs of physical abuse or water damage'
      ],
      restocking_fee_percent: 0,
      requires_photo_evidence: false
    };
  }

  if (['mens-shirts', 'tops', 'womens-dresses'].includes(cat)) {
    return {
      eligible: true,
      window_days: 14,
      policy_type: 'full_refund_or_exchange',
      title: '14-Day Free Returns & Size Exchange',
      description: 'Try it on! If the size, color, or fit is not ideal, exchange for another size or return for full refund/store credit with free pickup.',
      conditions: [
        'Original brand tags attached and intact',
        'Unwashed, unworn, without perfume or deodorant stains',
        'Original polybag packaging preserved'
      ],
      restocking_fee_percent: 0,
      requires_photo_evidence: false
    };
  }

  if (['mens-shoes'].includes(cat)) {
    return {
      eligible: true,
      window_days: 14,
      policy_type: 'full_refund_or_exchange',
      title: '14-Day Free Size Exchange & Returns',
      description: 'Please test shoes indoors on clean carpets. Returns accepted within 14 days in original shoe box.',
      conditions: [
        'Soles must be pristine with zero outdoor scuff marks',
        'Original brand shoe box and packaging mandatory'
      ],
      restocking_fee_percent: 0,
      requires_photo_evidence: false
    };
  }

  if (['mens-watches', 'womens-watches', 'womens-jewellery', 'womens-bags', 'bags', 'sunglasses'].includes(cat)) {
    return {
      eligible: true,
      window_days: 10,
      policy_type: 'full_refund_or_replacement',
      title: '10-Day Return with Authenticity Inspection',
      description: 'Eligible for return within 10 days. Must include authenticity cards, certificates, protective films, and luxury presentation box.',
      conditions: [
        'Authenticity cards, warranty certificates intact',
        'Zero scratches, resizing, or link removals',
        'Complete original branded packaging and dust bag'
      ],
      restocking_fee_percent: 0,
      requires_photo_evidence: false
    };
  }

  if (['kitchen-accessories', 'home-decoration', 'furniture', 'sports-accessories'].includes(cat)) {
    return {
      eligible: true,
      window_days: 15,
      policy_type: 'full_refund_or_replacement',
      title: '15-Day Hassle-Free Returns',
      description: 'Return or replace within 15 days of delivery. Product must be in original condition with all parts and assembly manuals.',
      conditions: [
        'All components, screws, and accessories intact',
        'Product in clean, resellable condition'
      ],
      restocking_fee_percent: 0,
      requires_photo_evidence: false
    };
  }

  if (['vehicle', 'motorcycle'].includes(cat)) {
    return {
      eligible: false,
      window_days: 0,
      policy_type: 'dealership_warranty_only',
      title: 'Dealership Warranty Only (Non-Returnable)',
      description: 'Vehicles are registered to owner and non-returnable post delivery. Covered under authorized manufacturer dealership warranty.',
      conditions: [
        'Authorized service center support only',
        'Manufacturer warranty coverage applies'
      ],
      restocking_fee_percent: 0,
      requires_photo_evidence: false
    };
  }

  // Default Standard Policy
  return {
    eligible: true,
    window_days: 14,
    policy_type: 'full_refund_or_replacement',
    title: '14-Day Standard Return Policy',
    description: 'Return or exchange within 14 days of delivery. Item must be in original unused condition with all tags and packaging.',
    conditions: [
      'Original condition and packaging',
      'Proof of purchase/Order ID'
    ],
    restocking_fee_percent: 0,
    requires_photo_evidence: false
  };
}

async function run() {
  console.log('🔄 Fetching all products from Firestore...');
  const snapshot = await getDocs(collection(db, 'products'));
  console.log(`Found ${snapshot.size} products. Updating return policies...`);

  let count = 0;
  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const policy = getReturnPolicyForCategory(data.category);

    await updateDoc(doc(db, 'products', docSnap.id), {
      return_policy: policy,
      policy_updated_at: new Date().toISOString()
    });

    count++;
    if (count % 10 === 0 || count === snapshot.size) {
      console.log(`Progress: [${count}/${snapshot.size}] Updated: "${data.name}" (${data.category}) -> ${policy.title}`);
    }
  }

  console.log(`\n🎉 Successfully updated ${count} products in Firestore with category-relevant return policies!`);
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Error updating Firestore products:', err);
  process.exit(1);
});
