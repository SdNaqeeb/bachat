/**
 * THE contract test. Every payload here is a real Worker response captured by
 * `worker/test/contract.test.ts` (see ./wire.ts), and every assertion is about
 * the mapping from that real payload into this app's domain types.
 *
 * This file exists because the app and the Worker were built in parallel and
 * silently disagreed on almost every route: the app read `offers` where the
 * Worker sends `results`, `points` where it sends `series`, `items_total` (a
 * COUNT) where it meant `subtotal` (money). None of that failed a typecheck,
 * a lint or a test — it only failed on a real phone against a real server.
 * Anything that drifts again now fails here.
 */

import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api-error';
import {
  decodeBasket,
  decodeBasketItems,
  decodeCompare,
  decodeDeals,
  decodeFacets,
  decodeHealth,
  decodeHistory,
  decodePrefs,
  encodeBasket,
  encodePrefs,
} from '@/lib/decode';
import { findNumericRot, wire } from './wire';

const HOUR = 3_600_000;
const CAPTURE_NOW = Date.parse('2026-09-12T09:00:00.000Z');

describe('GET /api/health', () => {
  const report = decodeHealth(wire('health'));

  it('rolls the per-retailer array up into the per-mode report the app renders', () => {
    expect(report.status).toBe('degraded');
    expect(report.staleSweep).toBe(true);
    expect(report.lastSweepAt.quick).toBe(CAPTURE_NOW - 2 * HOUR);
    expect(report.lastSweepAt.fashion).toBe(CAPTURE_NOW - 5 * HOUR);
  });

  it('reads counts as counts, not as the retailer array', () => {
    // The Worker sends `retailers` as an ARRAY and the count as
    // `retailer_count`. Reading the array into a number field is the exact
    // mismatch this layer exists to stop; it would render "0 retailers".
    expect(report.retailers).toBe(6);
    expect(report.products).toBe(7);
    expect(report.retailerHealth).toHaveLength(6);
  });

  it('keeps the per-retailer detail so Settings can name the stale retailer', () => {
    const instamart = report.retailerHealth?.find((r) => r.id === 'instamart');
    expect(instamart?.stale).toBe(true);
    expect(instamart?.mode).toBe('quick');

    const flipkart = report.retailerHealth?.find((r) => r.id === 'flipkart');
    // Never swept is null, never 0 — 0 would render as 1970.
    expect(flipkart?.lastSweepAt).toBeNull();
  });

  it('carries push-delivery health (spec §10)', () => {
    expect(report.lastPushSentAt).toBe(CAPTURE_NOW - 6 * HOUR);
  });
});

describe('GET /api/basket', () => {
  const basket = decodeBasket(wire('basket-quick'), 'quick');

  it('pivots the Worker per-retailer grouping into per-item lines', () => {
    // Wire: retailers[].lines[]. Domain: lines[].offers[].
    expect(basket.lines.map((l) => l.item.label)).toEqual([
      'Amul Taaza 500 ml',
      'Brown Bread',
    ]);
    const milk = basket.lines[0];
    expect(milk?.offers.map((o) => o.retailerId).sort()).toEqual([
      'bigbasket',
      'blinkit',
      'instamart',
    ]);
    // Bread is stocked by two of the three retailers; the third is absent, not
    // present-with-a-zero.
    expect(basket.lines[1]?.offers).toHaveLength(2);
  });

  it('reads MONEY from subtotal, not from the items_total COUNT', () => {
    const blinkit = basket.quotes.find((q) => q.retailerId === 'blinkit');
    // 2 x milk @28 + 1 x bread @45 = 101, and the Worker's items_total is 2.
    expect(blinkit?.itemsTotal).toBe(101);
    expect(blinkit?.itemCount).toBe(2);
    expect(blinkit?.total).toBe(126); // + 25 delivery
    expect(blinkit?.deliveryFee).toBe(25);
    expect(blinkit?.inStockCount).toBe(2);
  });

  it('states a partial retailer gap as labels, not as objects', () => {
    const instamart = basket.quotes.find((q) => q.retailerId === 'instamart');
    // The Worker sends [{ basket_item_id, label }]; a naive string filter
    // yields [] and the UI silently claims nothing is missing.
    expect(instamart?.missing).toEqual(['Brown Bread']);
    expect(instamart?.fullyStocked).toBe(false);
  });

  it('ranks fully-stocked retailers first and never lets a partial one win (§8)', () => {
    // Instamart has the cheapest basket_total of all (48) because it is only
    // pricing half the basket.
    expect(basket.quotes[0]?.retailerId).toBe('blinkit');
    expect(basket.winnerRetailerId).toBe('blinkit');
    expect(basket.runnerUpRetailerId).toBe('bigbasket');
    // Against the RUNNER-UP, not against the worst option.
    expect(basket.savingVsRunnerUp).toBe(18);
  });

  it('carries a deep link and product detail onto every basket offer', () => {
    const offer = basket.lines[0]?.offers.find((o) => o.retailerId === 'blinkit');
    expect(offer?.deeplink).toBe('blinkit://product/milk?utm_source=bachat');
    expect(offer?.brand).toBe('Amul');
    expect(offer?.pack).toBe('500 ml');
    expect(offer?.price).toBe(28);
    expect(offer?.capturedAt).toBe(CAPTURE_NOW - 2 * HOUR);
  });

  it('ages a quote by its OLDEST line', () => {
    const blinkit = basket.quotes.find((q) => q.retailerId === 'blinkit');
    expect(blinkit?.capturedAt).toBe(CAPTURE_NOW - 2 * HOUR);
    expect(basket.capturedAt).toBe(CAPTURE_NOW - 40 * HOUR); // instamart's stale line
  });
});

describe('POST /api/basket', () => {
  it('sends the replace action the Worker actually implements', () => {
    const body = encodeBasket('quick', [
      { id: 'i-milk', label: 'Amul Taaza 500 ml', qty: 3, category: 'dairy' },
      { label: 'Eggs (6)', qty: 1, category: '' },
    ]);
    expect(body.action).toBe('replace');
    expect(body.mode).toBe('quick');
    expect(body.items).toEqual([
      { basket_item_id: 'i-milk', label: 'Amul Taaza 500 ml', qty: 3, category: 'dairy' },
      { basket_item_id: undefined, label: 'Eggs (6)', qty: 1, category: null },
    ]);
  });

  it('decodes the stored basket back', () => {
    const items = decodeBasketItems(wire('basket-replace'), 'quick');
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      id: 'i-milk',
      label: 'Amul Taaza 500 ml',
      qty: 3,
      mode: 'quick',
      category: 'dairy',
    });
  });
});

describe('GET /api/deals', () => {
  const feed = decodeDeals(wire('deals-quick'), 'quick');

  it('maps the Worker `items` onto the app `deals`', () => {
    expect(feed.deals.length).toBeGreaterThan(0);
    expect(feed.mode).toBe('quick');
    expect(feed.sweptAt).toBe(CAPTURE_NOW - 2 * HOUR);
    expect(feed.nextCursor).toBeNull();
  });

  it('labels a deal period-low only when the server says it is one', () => {
    const milk = feed.deals.find((d) => d.offer.productId === 'blinkit:milk');
    expect(milk?.kind).toBe('period-low');
    expect(milk?.offer.historyDays).toBe(12);
    expect(milk?.offer.periodLowClaim).toBe('lowest in 12 days');

    const bread = feed.deals.find((d) => d.offer.productId === 'blinkit:bread');
    expect(bread?.kind).toBe('threshold');
    expect(bread?.offer.isPeriodLow).toBe(false);
  });

  it('carries discount and saving without inventing either', () => {
    const milk = feed.deals.find((d) => d.offer.productId === 'blinkit:milk');
    expect(milk?.discountPct).toBeCloseTo(0.2, 3); // (35 - 28) / 35
    expect(milk?.savedAmount).toBe(7);
  });
});

describe('GET /api/compare', () => {
  it('reads `results`, which is what the Worker actually calls the list', () => {
    const result = decodeCompare(wire('compare-quick'), 'quick', 'Amul');
    // Reading `offers` off this body — the app's own name for the field —
    // yields an empty, and entirely plausible-looking, "no results" screen.
    expect(result.offers).toHaveLength(3);
    expect(result.query).toBe('Amul');
    expect(result.mode).toBe('quick');
    expect(result.offers[0]?.price).toBe(24); // cheapest first
    expect(result.offers[0]?.category).toBe('dairy');
    expect(result.sweptAt).toBe(CAPTURE_NOW - 2 * HOUR);
  });

  it('sorts in-stock offers ahead of out-of-stock ones whatever the price', () => {
    const result = decodeCompare(wire('compare-fashion'), 'fashion', 'Tee');
    // The Amazon tee is cheaper (899 vs 1499) but out of stock.
    expect(result.offers.map((o) => o.retailerId)).toEqual(['myntra', 'amazon']);
    expect(result.offers[1]?.inStock).toBe(false);
  });

  it('reports no period-low claim at all on a route that carries no history', () => {
    const result = decodeCompare(wire('compare-quick'), 'quick', 'Amul');
    for (const offer of result.offers) {
      expect(offer.periodLowClaim).toBeNull();
      expect(offer.historyDays).toBe(0);
      expect(offer.isPeriodLow).toBe(false);
    }
  });
});

describe('GET /api/history/:productId', () => {
  it('reads `series` into `points` and keeps the real N', () => {
    const history = decodeHistory(wire('history-partial'), 'blinkit:milk');
    expect(history.points).toHaveLength(12);
    expect(history.points[0]).toEqual({ day: '2026-09-01', minPrice: 31, maxPrice: 35 });
    expect(history.days).toBe(12);
    expect(history.daysRequested).toBe(30);
    expect(history.low).toBe(28);
    expect(history.high).toBe(35);
    expect(history.currentPrice).toBe(28);
    expect(history.isPeriodLow).toBe(true);
  });

  it('reports a full window as a full window', () => {
    const history = decodeHistory(wire('history-full'), 'bigbasket:milk');
    expect(history.days).toBe(30);
    expect(history.isPeriodLow).toBe(false);
  });
});

describe('GET /api/facets', () => {
  it('supplies the retailer and category pickers the app asks for', () => {
    const facets = decodeFacets(wire('facets-quick'), 'quick');
    expect(facets.retailers.map((r) => r.id)).toEqual(['bigbasket', 'blinkit', 'instamart']);
    expect(facets.retailers[1]).toMatchObject({
      id: 'blinkit',
      name: 'Blinkit',
      mode: 'quick',
      initials: 'BL',
    });
    expect(facets.categories).toEqual([
      { id: 'bakery', label: 'Bakery', mode: 'quick', productCount: 2 },
      { id: 'dairy', label: 'Dairy', mode: 'quick', productCount: 3 },
    ]);
    expect(facets.sizes).toEqual([]);
  });

  it('carries fashion brands and sizes', () => {
    const facets = decodeFacets(wire('facets-fashion'), 'fashion');
    expect(facets.brands).toEqual(['Levis', 'Nike']);
    expect(facets.sizes).toEqual(['L', 'M']);
    expect(facets.categories.map((c) => c.label)).toEqual(['Tshirts']);
  });
});

describe('/api/prefs', () => {
  it('decodes the flat pref key map into the app settings shape', () => {
    const prefs = decodePrefs(wire('prefs'));
    expect(prefs.threshold).toBe(0.6);
    // "23:00" on the wire, hour-of-day in the app.
    expect(prefs.quietHours).toEqual({ start: 23, end: 8 });
    expect(prefs.pincode).toBe('');
    expect(prefs.lat).toBeNull();
    expect(prefs.fees.blinkit).toEqual({ deliveryFee: 20, handlingFee: 5 });
    expect(prefs.enabledCategories).toContain('dairy');
    expect(prefs.notificationsEnabled).toBe(true);
  });

  it('encodes only the keys actually being changed', () => {
    expect(encodePrefs({ threshold: 0.45 })).toEqual({ threshold_pct: 0.45 });
    expect(encodePrefs({ quietHours: { start: 22, end: 7 } })).toEqual({
      quiet_hours: { start: '22:00', end: '07:00' },
    });
    expect(encodePrefs({ fees: { blinkit: { deliveryFee: 20, handlingFee: 5 } } })).toEqual({
      // No eta_minutes: the app has no UI for it, and the Worker merges
      // object prefs one level deep so the stored value survives.
      'fees.blinkit': { delivery: 20, handling: 5 },
    });
    expect(encodePrefs({ pincode: '560103' })).toEqual({ location: { pincode: '560103' } });
    expect(encodePrefs({})).toEqual({});
  });

  it('round-trips a fee edit through the Worker key naming', () => {
    const encoded = encodePrefs({ fees: { blinkit: { deliveryFee: 20, handlingFee: 5 } } });
    const stored = { prefs: { ...encoded } };
    expect(decodePrefs(stored).fees.blinkit).toEqual({ deliveryFee: 20, handlingFee: 5 });
  });
});

describe('every decoded payload', () => {
  it('contains no NaN or Infinity anywhere', () => {
    const decoded = [
      decodeHealth(wire('health')),
      decodeBasket(wire('basket-quick'), 'quick'),
      decodeBasketItems(wire('basket-replace'), 'quick'),
      decodeDeals(wire('deals-quick'), 'quick'),
      decodeCompare(wire('compare-quick'), 'quick', 'Amul'),
      decodeCompare(wire('compare-fashion'), 'fashion', 'Tee'),
      decodeHistory(wire('history-partial'), 'blinkit:milk'),
      decodeHistory(wire('history-empty'), 'blinkit:bread'),
      decodeHistory(wire('history-full'), 'bigbasket:milk'),
      decodeFacets(wire('facets-quick'), 'quick'),
      decodeFacets(wire('facets-fashion'), 'fashion'),
      decodePrefs(wire('prefs')),
    ];
    expect(decoded.flatMap((value, i) => findNumericRot(value, `[${i}]`))).toEqual([]);
  });

  it('is rejected wholesale when the body is not an object', () => {
    for (const body of [null, 'nope', 42, []]) {
      expect(() => decodeHealth(body)).toThrow(ApiError);
    }
  });
});
