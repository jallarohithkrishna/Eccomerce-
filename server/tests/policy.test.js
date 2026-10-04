/**
 * Policy Engine — 30 Golden Tests (Phase 2)
 * Run: node --test tests/policy.test.js
 *
 * Coverage:
 * - Every category (groceries, beauty, electronics, fashion, luxury, home, vehicle, standard)
 * - Window edges: day 0, last day, day after
 * - Damage exceptions (grocery 24h perishable)
 * - High-value threshold → HUMAN_REVIEW
 * - Partial quantities
 * - Missing photo evidence
 * - Beauty seal intact/broken
 * - Fashion tags removed / item worn
 * - Luxury missing authenticity cards / packaging
 * - Home missing parts
 * - Category alias resolution
 * - Electronics name-keyword detection
 * - Repeated policies (idempotency of evaluate())
 */

import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import { evaluate, resolveCategory, daysBetween } from '../policy/engine.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Returns an ISO date N days offset from a base date */
function isoPlus(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

const BASE_DELIVERY = '2024-01-01T10:00:00.000Z';

function req(overrides = {}) {
  return {
    category:      'standard',
    itemName:      'Test Item',
    deliveredAt:   BASE_DELIVERY,
    requestedAt:   isoPlus(BASE_DELIVERY, 1),
    itemPrice:     500,
    quantity:      1,
    reason:        'not_needed',
    photoProvided: false,
    ...overrides,
  };
}

// ── daysBetween helper tests ───────────────────────────────────────────────

describe('daysBetween()', () => {
  it('same day → 0', () => {
    assert.equal(daysBetween('2024-01-01', '2024-01-01'), 0);
  });
  it('next day → 1', () => {
    assert.equal(daysBetween('2024-01-01', '2024-01-02'), 1);
  });
  it('7 days later → 7', () => {
    assert.equal(daysBetween('2024-01-01', '2024-01-08'), 7);
  });
});

// ── resolveCategory tests ──────────────────────────────────────────────────

describe('resolveCategory()', () => {
  it('electronics alias "smartphones" → "electronics"', () => {
    assert.equal(resolveCategory('smartphones'), 'electronics');
  });
  it('alias "mens-shirts" → "fashion"', () => {
    assert.equal(resolveCategory('mens-shirts'), 'fashion');
  });
  it('alias "jewellery" → "luxury"', () => {
    assert.equal(resolveCategory('jewellery'), 'luxury');
  });
  it('unknown → "standard"', () => {
    assert.equal(resolveCategory('mystery-category'), 'standard');
  });
  it('electronics via item name "iPhone 15 Pro"', () => {
    assert.equal(resolveCategory('', 'iPhone 15 Pro'), 'electronics');
  });
  it('electronics via item name "MacBook Air"', () => {
    assert.equal(resolveCategory('general', 'MacBook Air'), 'electronics');
  });
});

// ── Groceries ─────────────────────────────────────────────────────────────

describe('Groceries policy', () => {
  it('T01 – non-damage reason → NON_RETURNABLE_CATEGORY (not eligible)', () => {
    const r = evaluate(req({ category: 'groceries', reason: 'not_needed' }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'NON_RETURNABLE_CATEGORY');
  });

  it('T02 – damage within 24h, photo provided → GROCERY_DAMAGE_EXCEPTION (eligible)', () => {
    const deliveredAt = BASE_DELIVERY;
    const requestedAt = isoPlus(BASE_DELIVERY, 0); // same day, <24h
    const r = evaluate(req({
      category: 'groceries', reason: 'damage',
      deliveredAt, requestedAt, photoProvided: true,
    }));
    assert.equal(r.eligible, true);
    assert.equal(r.decisionCode, 'GROCERY_DAMAGE_EXCEPTION');
  });

  it('T03 – spoilage within 24h but no photo → PHOTO_REQUIRED', () => {
    const r = evaluate(req({
      category: 'groceries', reason: 'spoiled',
      requestedAt: isoPlus(BASE_DELIVERY, 0),
      photoProvided: false,
    }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'PHOTO_REQUIRED');
  });

  it('T04 – damage reported after 24h → GROCERY_DAMAGE_WINDOW_EXPIRED', () => {
    const r = evaluate(req({
      category: 'groceries', reason: 'damage',
      requestedAt: isoPlus(BASE_DELIVERY, 2), // 48h later
      photoProvided: true,
    }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'GROCERY_DAMAGE_WINDOW_EXPIRED');
  });
});

// ── Beauty ────────────────────────────────────────────────────────────────

describe('Beauty policy', () => {
  it('T05 – day 1, seal intact, photo → ELIGIBLE (replacement_only)', () => {
    const r = evaluate(req({
      category: 'beauty', reason: 'defect',
      photoProvided: true, sealIntact: true,
      requestedAt: isoPlus(BASE_DELIVERY, 1),
    }));
    assert.equal(r.eligible, true);
    assert.deepEqual(r.allowedResolutions, ['replacement']);
  });

  it('T06 – last day (day 7), seal intact → ELIGIBLE', () => {
    const r = evaluate(req({
      category: 'beauty', photoProvided: true, sealIntact: true,
      requestedAt: isoPlus(BASE_DELIVERY, 7),
    }));
    assert.equal(r.eligible, true);
  });

  it('T07 – day 8 (expired window) → WINDOW_EXPIRED', () => {
    const r = evaluate(req({
      category: 'beauty', photoProvided: true, sealIntact: true,
      requestedAt: isoPlus(BASE_DELIVERY, 8),
    }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'WINDOW_EXPIRED');
  });

  it('T08 – seal broken → SEAL_BROKEN (not eligible)', () => {
    const r = evaluate(req({
      category: 'beauty', photoProvided: true, sealIntact: false,
    }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'SEAL_BROKEN');
  });

  it('T09 – photo missing → PHOTO_REQUIRED', () => {
    const r = evaluate(req({ category: 'beauty', photoProvided: false, sealIntact: true }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'PHOTO_REQUIRED');
  });
});

// ── Electronics ───────────────────────────────────────────────────────────

describe('Electronics policy', () => {
  it('T10 – within 7 days → SERVICE_CENTER_ONLY (not eligible)', () => {
    const r = evaluate(req({
      category: 'electronics', requestedAt: isoPlus(BASE_DELIVERY, 3),
    }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'SERVICE_CENTER_ONLY');
  });

  it('T11 – item name "PS5 Console" → electronics → SERVICE_CENTER_ONLY', () => {
    const r = evaluate(req({ category: 'gaming', itemName: 'PS5 Console' }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'SERVICE_CENTER_ONLY');
  });

  it('T12 – zero allowed resolutions for electronics', () => {
    const r = evaluate(req({ category: 'smartphones' }));
    assert.deepEqual(r.allowedResolutions, []);
  });
});

// ── Fashion ───────────────────────────────────────────────────────────────

describe('Fashion policy', () => {
  it('T13 – day 0, tags attached → ELIGIBLE', () => {
    const r = evaluate(req({
      category: 'fashion', tagsAttached: true,
      requestedAt: isoPlus(BASE_DELIVERY, 0),
    }));
    assert.equal(r.eligible, true);
  });

  it('T14 – day 14 (last day), tags attached → ELIGIBLE', () => {
    const r = evaluate(req({
      category: 'fashion', tagsAttached: true,
      requestedAt: isoPlus(BASE_DELIVERY, 14),
    }));
    assert.equal(r.eligible, true);
  });

  it('T15 – day 15 (expired) → WINDOW_EXPIRED', () => {
    const r = evaluate(req({
      category: 'fashion', tagsAttached: true,
      requestedAt: isoPlus(BASE_DELIVERY, 15),
    }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'WINDOW_EXPIRED');
  });

  it('T16 – tags removed → TAGS_REMOVED', () => {
    const r = evaluate(req({ category: 'fashion', tagsAttached: false }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'TAGS_REMOVED');
  });

  it('T17 – item worn/washed → ITEM_WORN_WASHED', () => {
    const r = evaluate(req({
      category: 'fashion', tagsAttached: true, flags: { wornOrWashed: true },
    }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'ITEM_WORN_WASHED');
  });
});

// ── Luxury ────────────────────────────────────────────────────────────────

describe('Luxury policy', () => {
  it('T18 – day 5, auth cards, packaging → ELIGIBLE', () => {
    const r = evaluate(req({
      category: 'luxury', authenticityCards: true, originalPackaging: true,
      requestedAt: isoPlus(BASE_DELIVERY, 5),
    }));
    assert.equal(r.eligible, true);
  });

  it('T19 – high value (₹60000 > ₹50000 threshold) → HUMAN_REVIEW', () => {
    const r = evaluate(req({
      category: 'luxury', authenticityCards: true, originalPackaging: true,
      itemPrice: 60000, requestedAt: isoPlus(BASE_DELIVERY, 5),
    }));
    assert.equal(r.eligible, true);
    assert.equal(r.requiresHumanReview, true);
    assert.equal(r.decisionCode, 'HIGH_VALUE_HUMAN_REVIEW');
  });

  it('T20 – exactly at threshold (₹50000) → HUMAN_REVIEW', () => {
    const r = evaluate(req({
      category: 'luxury', authenticityCards: true, originalPackaging: true,
      itemPrice: 50000,
    }));
    assert.equal(r.requiresHumanReview, true);
  });

  it('T21 – missing authenticity cards → MISSING_AUTHENTICITY_CARDS', () => {
    const r = evaluate(req({
      category: 'luxury', authenticityCards: false, originalPackaging: true,
    }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'MISSING_AUTHENTICITY_CARDS');
  });

  it('T22 – missing packaging → MISSING_ORIGINAL_PACKAGING', () => {
    const r = evaluate(req({
      category: 'luxury', authenticityCards: true, originalPackaging: false,
    }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'MISSING_ORIGINAL_PACKAGING');
  });

  it('T23 – expired (day 11) → WINDOW_EXPIRED', () => {
    const r = evaluate(req({
      category: 'luxury', authenticityCards: true, originalPackaging: true,
      requestedAt: isoPlus(BASE_DELIVERY, 11),
    }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'WINDOW_EXPIRED');
  });
});

// ── Home ──────────────────────────────────────────────────────────────────

describe('Home policy', () => {
  it('T24 – day 15 (last day), all parts → ELIGIBLE', () => {
    const r = evaluate(req({
      category: 'home', allPartsIncluded: true,
      requestedAt: isoPlus(BASE_DELIVERY, 15),
    }));
    assert.equal(r.eligible, true);
  });

  it('T25 – missing parts → MISSING_PARTS', () => {
    const r = evaluate(req({ category: 'home', allPartsIncluded: false }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'MISSING_PARTS');
  });

  it('T26 – day 16 → WINDOW_EXPIRED', () => {
    const r = evaluate(req({
      category: 'home', allPartsIncluded: true,
      requestedAt: isoPlus(BASE_DELIVERY, 16),
    }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'WINDOW_EXPIRED');
  });
});

// ── Vehicle ───────────────────────────────────────────────────────────────

describe('Vehicle policy', () => {
  it('T27 – vehicle is non-returnable regardless of timing', () => {
    const r = evaluate(req({ category: 'vehicle', requestedAt: isoPlus(BASE_DELIVERY, 1) }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'NON_RETURNABLE_CATEGORY');
  });
});

// ── Standard ─────────────────────────────────────────────────────────────

describe('Standard policy', () => {
  it('T28 – day 0 → ELIGIBLE', () => {
    const r = evaluate(req({ requestedAt: isoPlus(BASE_DELIVERY, 0) }));
    assert.equal(r.eligible, true);
  });

  it('T29 – day 14 → ELIGIBLE', () => {
    const r = evaluate(req({ requestedAt: isoPlus(BASE_DELIVERY, 14) }));
    assert.equal(r.eligible, true);
  });

  it('T30 – day 15 → WINDOW_EXPIRED', () => {
    const r = evaluate(req({ requestedAt: isoPlus(BASE_DELIVERY, 15) }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'WINDOW_EXPIRED');
  });

  it('T31 – quantity 0 → INVALID_QUANTITY', () => {
    const r = evaluate(req({ quantity: 0 }));
    assert.equal(r.eligible, false);
    assert.equal(r.decisionCode, 'INVALID_QUANTITY');
  });

  it('T32 – evaluate() is referentially pure (same input → same output)', () => {
    const input = req({ requestedAt: isoPlus(BASE_DELIVERY, 5) });
    const r1 = evaluate(input);
    const r2 = evaluate(input);
    assert.equal(r1.eligible, r2.eligible);
    assert.equal(r1.decisionCode, r2.decisionCode);
  });
});
