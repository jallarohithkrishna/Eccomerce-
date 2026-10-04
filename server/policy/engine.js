/**
 * Policy Engine — PS-01
 * Deterministic eligibility evaluation. No LLM. No side-effects.
 * Input: { category, itemName, deliveredAt, requestedAt, itemPrice, quantity, reason, photoProvided, flags }
 * Output: EligibilityResult { eligible, resolution, policyType, reason, requiresHumanReview, policy }
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICY = JSON.parse(
  readFileSync(resolve(__dirname, 'policy.v1.json'), 'utf8')
);

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve a raw category string to a canonical policy key.
 */
export function resolveCategory(rawCategory = '', itemName = '') {
  const cat = rawCategory.toLowerCase().trim();

  // Check aliases map first
  if (POLICY.category_aliases[cat]) {
    return POLICY.category_aliases[cat];
  }

  // Check direct category match
  if (POLICY.categories[cat]) {
    return cat;
  }

  // Keyword-based electronics name detection
  const name = itemName.toLowerCase();
  for (const kw of POLICY.electronics_name_keywords) {
    if (name.includes(kw)) return 'electronics';
  }

  // Partial alias match (covers e.g. "mens-shirts-xl" → "fashion")
  for (const [alias, canonical] of Object.entries(POLICY.category_aliases)) {
    if (cat.includes(alias) || alias.includes(cat)) return canonical;
  }

  return 'standard';
}

/**
 * Calculate days between two ISO dates.
 * Returns a non-negative integer (0 = same day, 1 = next day).
 */
export function daysBetween(isoStart, isoEnd) {
  const start = new Date(isoStart);
  const end   = new Date(isoEnd);
  const diffMs = end - start;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// ─── core engine ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} EligibilityInput
 * @property {string}  category      - Product category (raw; will be resolved)
 * @property {string}  [itemName]    - Product name (used for electronics keyword detection)
 * @property {string}  deliveredAt   - ISO delivery date
 * @property {string}  requestedAt   - ISO return request date
 * @property {number}  [itemPrice]   - Unit price in INR
 * @property {number}  [quantity]    - Number of units to return (must be >= 1)
 * @property {string}  [reason]      - Return reason keyword (damage|defect|wrong_item|not_needed|spoiled|other)
 * @property {boolean} [photoProvided]   - Whether customer uploaded photo evidence
 * @property {boolean} [sealIntact]      - Beauty seal status
 * @property {boolean} [tagsAttached]    - Fashion tags status
 * @property {boolean} [authenticityCards] - Luxury cards status
 * @property {boolean} [originalPackaging] - Luxury/home packaging status
 * @property {boolean} [allPartsIncluded]  - Home all-parts status
 * @property {Object}  [flags]            - Additional free-form flags
 */

/**
 * @typedef {Object} EligibilityResult
 * @property {boolean}  eligible
 * @property {string}   policyKey      - canonical policy category
 * @property {string}   policyType     - e.g. 'full_refund_or_exchange'
 * @property {string[]} allowedResolutions
 * @property {boolean}  requiresHumanReview
 * @property {string}   decisionCode   - machine-readable reason
 * @property {string}   decisionMessage - human-readable reason
 * @property {number}   daysElapsed
 * @property {number}   windowDays
 * @property {Object}   policy         - full policy object for reference
 */

/**
 * Evaluate eligibility for a return request.
 * Throws if input is fundamentally invalid.
 *
 * @param {EligibilityInput} input
 * @returns {EligibilityResult}
 */
export function evaluate(input) {
  const {
    category      = '',
    itemName      = '',
    deliveredAt,
    requestedAt,
    itemPrice     = 0,
    quantity      = 1,
    reason        = '',
    photoProvided = false,
    sealIntact,
    tagsAttached,
    authenticityCards,
    originalPackaging,
    allPartsIncluded,
    flags         = {},
  } = input;

  if (!deliveredAt) throw new Error('deliveredAt is required');
  if (!requestedAt) throw new Error('requestedAt is required');

  const policyKey = resolveCategory(category, itemName);
  const policy    = POLICY.categories[policyKey];

  const daysElapsed = daysBetween(deliveredAt, requestedAt);
  const windowDays  = policy.window_days;

  // Quantity guard
  if (quantity < 1) {
    return deny(policyKey, policy, daysElapsed, windowDays, 'INVALID_QUANTITY', 'Return quantity must be at least 1.');
  }

  // ── 1. Completely non-returnable categories ──────────────────────────────
  if (!policy.eligible) {

    // Groceries: damage exception within 24h window
    if (policyKey === 'groceries' && policy.damage_exception) {
      const hoursElapsed = (new Date(requestedAt) - new Date(deliveredAt)) / (1000 * 60 * 60);
      const isDamageReport = ['damage', 'defect', 'spoiled', 'wrong_item'].includes(reason.toLowerCase());

      if (isDamageReport && hoursElapsed <= policy.damage_window_hours) {
        if (policy.requires_photo_evidence && !photoProvided) {
          return deny(policyKey, policy, daysElapsed, windowDays,
            'PHOTO_REQUIRED',
            'Photo evidence of damage or spoilage is required for grocery claims.');
        }
        return approve(policyKey, policy, daysElapsed, windowDays,
          'GROCERY_DAMAGE_EXCEPTION',
          `Damage/spoilage reported within ${policy.damage_window_hours}h window. Eligible for refund or replacement.`,
          false);
      }

      if (!isDamageReport) {
        return deny(policyKey, policy, daysElapsed, windowDays,
          'NON_RETURNABLE_CATEGORY',
          'Grocery and perishable items are non-returnable. Only damage or spoilage reported within 24 hours is eligible.');
      }

      return deny(policyKey, policy, daysElapsed, windowDays,
        'GROCERY_DAMAGE_WINDOW_EXPIRED',
        `Damage must be reported within ${policy.damage_window_hours} hours of delivery. Request is ${Math.ceil(hoursElapsed)}h after delivery.`);
    }

    // Electronics and Vehicle
    if (policyKey === 'electronics') {
      return deny(policyKey, policy, daysElapsed, windowDays,
        'SERVICE_CENTER_ONLY',
        'Electronics are not eligible for store returns. Please visit an authorized service center with your invoice and warranty card.');
    }

    return deny(policyKey, policy, daysElapsed, windowDays,
      'NON_RETURNABLE_CATEGORY',
      `${policyKey.charAt(0).toUpperCase() + policyKey.slice(1)} items are non-returnable under our current policy.`);
  }

  // ── 2. Window check ──────────────────────────────────────────────────────
  if (daysElapsed > windowDays) {
    return deny(policyKey, policy, daysElapsed, windowDays,
      'WINDOW_EXPIRED',
      `Return window of ${windowDays} days has expired. Request was made ${daysElapsed} day(s) after delivery.`);
  }

  // ── 3. Photo evidence required ───────────────────────────────────────────
  if (policy.requires_photo_evidence && !photoProvided) {
    return deny(policyKey, policy, daysElapsed, windowDays,
      'PHOTO_REQUIRED',
      'Photo evidence is required for this category. Please upload a clear photo of the item.');
  }

  // ── 4. Category-specific condition checks ────────────────────────────────

  // Beauty: seal must be intact
  if (policyKey === 'beauty' && policy.seal_must_be_intact) {
    if (sealIntact === false) {
      return deny(policyKey, policy, daysElapsed, windowDays,
        'SEAL_BROKEN',
        'Opened or used personal care items are strictly non-returnable. The factory hygiene seal must be intact.');
    }
  }

  // Fashion: tags must be attached and item unworn/unwashed
  if (policyKey === 'fashion') {
    if (policy.tags_must_be_attached && tagsAttached === false) {
      return deny(policyKey, policy, daysElapsed, windowDays,
        'TAGS_REMOVED',
        'Original brand tags must be attached and intact for fashion returns.');
    }
    if (policy.must_be_unwashed_unworn && flags.wornOrWashed === true) {
      return deny(policyKey, policy, daysElapsed, windowDays,
        'ITEM_WORN_WASHED',
        'Item must be unworn and unwashed for return eligibility.');
    }
  }

  // Luxury: authenticity cards + original packaging
  if (policyKey === 'luxury') {
    if (policy.authenticity_cards_required && authenticityCards === false) {
      return deny(policyKey, policy, daysElapsed, windowDays,
        'MISSING_AUTHENTICITY_CARDS',
        'Authenticity cards and warranty certificates are required for luxury returns.');
    }
    if (policy.original_packaging_required && originalPackaging === false) {
      return deny(policyKey, policy, daysElapsed, windowDays,
        'MISSING_ORIGINAL_PACKAGING',
        'Complete original branded packaging is required for luxury item returns.');
    }
  }

  // Home: all parts required
  if (policyKey === 'home' && policy.all_parts_required && allPartsIncluded === false) {
    return deny(policyKey, policy, daysElapsed, windowDays,
      'MISSING_PARTS',
      'All original components, accessories, and assembly manuals must be included for home product returns.');
  }

  // ── 5. High-value threshold → HUMAN_REVIEW ───────────────────────────────
  if (policy.high_value_threshold && itemPrice >= policy.high_value_threshold) {
    return approve(policyKey, policy, daysElapsed, windowDays,
      'HIGH_VALUE_HUMAN_REVIEW',
      `Item value ₹${itemPrice} exceeds threshold ₹${policy.high_value_threshold}. Escalated for specialist review.`,
      true /* requiresHumanReview */);
  }

  // ── 6. Approved ───────────────────────────────────────────────────────────
  return approve(policyKey, policy, daysElapsed, windowDays,
    'ELIGIBLE',
    `Return request is within the ${windowDays}-day window and meets all policy conditions.`,
    false);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function approve(policyKey, policy, daysElapsed, windowDays, decisionCode, decisionMessage, requiresHumanReview) {
  return {
    eligible: true,
    policyKey,
    policyType: policy.policy_type,
    allowedResolutions: policy.allowed_resolutions,
    requiresHumanReview: !!requiresHumanReview,
    decisionCode,
    decisionMessage,
    daysElapsed,
    windowDays,
    policy,
  };
}

function deny(policyKey, policy, daysElapsed, windowDays, decisionCode, decisionMessage) {
  return {
    eligible: false,
    policyKey,
    policyType: policy.policy_type,
    allowedResolutions: [],
    requiresHumanReview: false,
    decisionCode,
    decisionMessage,
    daysElapsed,
    windowDays,
    policy,
  };
}
