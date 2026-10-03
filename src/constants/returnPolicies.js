/**
 * Standard Return & Exchange Policies across Catalog Categories
 */
export const RETURN_POLICIES = {
  groceries: {
    eligible: false,
    window_days: 0,
    policy_type: 'non_returnable',
    title: 'Non-Returnable (Perishable Food Item)',
    badge: 'Non-Returnable',
    badgeColor: 'bg-amber-50 text-amber-700 border-amber-200',
    description: 'Perishable food and grocery items cannot be returned due to food safety and hygiene regulations. If item arrived damaged or spoiled, report within 24 hours for instant refund or replacement.',
    conditions: [
      'Report within 24 hours of delivery',
      'Photo evidence of damage/spoilage required'
    ],
    restocking_fee_percent: 0,
    requires_photo_evidence: true
  },
  beauty: {
    eligible: true,
    window_days: 7,
    policy_type: 'replacement_only',
    title: '7-Day Replacement Only (Hygiene Sensitive)',
    badge: '7-Day Replacement',
    badgeColor: 'bg-purple-50 text-purple-700 border-purple-200',
    description: 'Eligible for replacement within 7 days only if arrived damaged, defective, or with broken seal. Opened or used personal care items are strictly non-returnable.',
    conditions: [
      'Factory hygiene seal must be intact',
      'Photo proof required if leaked or damaged in transit',
      'Replacement dispatched upon return approval'
    ],
    restocking_fee_percent: 0,
    requires_photo_evidence: true
  },
  electronics: {
    eligible: false,
    window_days: 7,
    policy_type: 'service_center_only',
    title: 'Service Center Replacement Only',
    badge: 'Service Center Only',
    badgeColor: 'bg-orange-50 text-orange-700 border-orange-200',
    description: 'Returns are not available for electronics. For defective or damaged items, please visit your nearest authorized service center for inspection and replacement under warranty.',
    conditions: [
      'Visit nearest authorized service center with product',
      'Carry original invoice and warranty card',
      'IMEI/Serial number must match purchase records',
      'All original accessories and packaging required'
    ],
    restocking_fee_percent: 0,
    requires_photo_evidence: true
  },
  fashion: {
    eligible: true,
    window_days: 14,
    policy_type: 'full_refund_or_exchange',
    title: '14-Day Free Returns & Size Exchange',
    badge: '14-Day Free Returns',
    badgeColor: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    description: 'Try it on! If the size, color, or fit is not ideal, exchange for another size or return for full refund/store credit with free pickup.',
    conditions: [
      'Original brand tags attached and intact',
      'Unwashed, unworn, without perfume or deodorant stains',
      'Original polybag packaging preserved'
    ],
    restocking_fee_percent: 0,
    requires_photo_evidence: false
  },
  luxury: {
    eligible: true,
    window_days: 10,
    policy_type: 'full_refund_or_replacement',
    title: '10-Day Return with Authenticity Inspection',
    badge: '10-Day Return',
    badgeColor: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    description: 'Eligible for return within 10 days. Must include authenticity cards, certificates, protective films, and luxury presentation box.',
    conditions: [
      'Authenticity cards, warranty certificates intact',
      'Zero scratches, resizing, or link removals',
      'Complete original branded packaging and dust bag'
    ],
    restocking_fee_percent: 0,
    requires_photo_evidence: false
  },
  home: {
    eligible: true,
    window_days: 15,
    policy_type: 'full_refund_or_replacement',
    title: '15-Day Hassle-Free Returns',
    badge: '15-Day Return',
    badgeColor: 'bg-teal-50 text-teal-700 border-teal-200',
    description: 'Return or replace within 15 days of delivery. Product must be in original condition with all parts and assembly manuals.',
    conditions: [
      'All components, screws, and accessories intact',
      'Product in clean, resellable condition'
    ],
    restocking_fee_percent: 0,
    requires_photo_evidence: false
  },
  vehicle: {
    eligible: false,
    window_days: 0,
    policy_type: 'dealership_warranty_only',
    title: 'Dealership Warranty Only (Non-Returnable)',
    badge: 'Warranty Only',
    badgeColor: 'bg-slate-100 text-slate-700 border-slate-300',
    description: 'Vehicles are registered to owner and non-returnable post delivery. Covered under authorized manufacturer dealership warranty.',
    conditions: [
      'Authorized service center support only',
      'Manufacturer warranty coverage applies'
    ],
    restocking_fee_percent: 0,
    requires_photo_evidence: false
  },
  standard: {
    eligible: true,
    window_days: 14,
    policy_type: 'full_refund_or_replacement',
    title: '14-Day Standard Return Policy',
    badge: '14-Day Return',
    badgeColor: 'bg-primary-50 text-primary-700 border-primary-200',
    description: 'Return or exchange within 14 days of delivery. Item must be in original unused condition with all tags and packaging.',
    conditions: [
      'Original condition and packaging',
      'Proof of purchase/Order ID'
    ],
    restocking_fee_percent: 0,
    requires_photo_evidence: false
  }
};

export function resolvePolicyForCategory(category = '') {
  const cat = (category || '').toLowerCase().trim();

  if (cat === 'groceries') return RETURN_POLICIES.groceries;
  if (['beauty', 'fragrances', 'skin-care'].includes(cat)) return RETURN_POLICIES.beauty;
  if (['smartphones', 'laptops', 'tablets'].includes(cat)) return RETURN_POLICIES.electronics;
  if (['mens-shirts', 'tops', 'womens-dresses', 'mens-shoes', 'clothing'].includes(cat)) return RETURN_POLICIES.fashion;
  if (['mens-watches', 'womens-watches', 'womens-jewellery', 'womens-bags', 'bags', 'sunglasses'].includes(cat)) return RETURN_POLICIES.luxury;
  if (['kitchen-accessories', 'home-decoration', 'furniture', 'sports-accessories', 'home'].includes(cat)) return RETURN_POLICIES.home;
  if (['vehicle', 'motorcycle'].includes(cat)) return RETURN_POLICIES.vehicle;

  return RETURN_POLICIES.standard;
}
