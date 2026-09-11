/**
 * The demo catalog behind the fixture client (spec §13).
 *
 * This is the data the four screens are built against while the Worker and the
 * collectors are still being written, so it is deliberately not a happy path.
 * It encodes the cases that are easy to forget and expensive to discover late:
 *
 * - **A partial-stock basket.** Blinkit is out of Amul Taaza, so it is cheaper
 *   on items but cannot win outright (spec §8). BigBasket is fully stocked but
 *   slower and dearer. The winner beats the runner-up by ₹34, not by the worst.
 * - **Thin history.** `bb-toor-dal` holds only 12 days of `price_daily`, so the
 *   UI must say "Lowest in 12 days" and never "30-day low" (spec §7).
 * - **A stale sweep.** The fashion sweep last completed 31 hours ago against a
 *   12-hour cadence, so every fashion price should render an amber staleness
 *   chip and the feed should say so at the top (spec §9, §12).
 * - **Mixed price ages inside one screen.** BigBasket sweeps on a slower clock
 *   than Blinkit, so a single basket carries offers of three different ages.
 *
 * Prices are plausible Indian street prices as of late 2026 but are invented.
 * Nothing here is scraped and no product ID matches a real retailer's.
 */

import type { Category, Mode, PricePoint, Retailer } from '@/lib/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ */
/* Sweep clock                                                         */
/* ------------------------------------------------------------------ */

/**
 * Sweep completion times, relative to whenever the app starts. Resolved
 * lazily so a session left open overnight ages its data honestly rather than
 * freezing at whatever the bundle was built at.
 */
export function sweptAt(mode: Mode, now: number = Date.now()): number {
  // Quick sweeps every 4 h; this one landed 1 h 18 m ago — fresh.
  // Fashion sweeps twice a day; this one is 31 h old — a failed sweep (§12).
  return mode === 'quick' ? now - (HOUR + 18 * MINUTE) : now - 31 * HOUR;
}

/** Per-retailer capture offset, so one screen shows three different ages. */
const CAPTURE_OFFSET: Record<string, number> = {
  blinkit: 0,
  zepto: 25 * MINUTE,
  // BigBasket's adapter paces slowly, so its rows are always the oldest.
  bigbasket: 4 * HOUR + 40 * MINUTE,
  myntra: 0,
  amazon: 90 * MINUTE,
  flipkart: 3 * HOUR,
};

export function capturedAtFor(retailerId: string, mode: Mode, now: number = Date.now()): number {
  return sweptAt(mode, now) - (CAPTURE_OFFSET[retailerId] ?? 0);
}

/* ------------------------------------------------------------------ */
/* Retailers                                                           */
/* ------------------------------------------------------------------ */

export const RETAILERS: readonly Retailer[] = [
  {
    id: 'blinkit',
    name: 'Blinkit',
    mode: 'quick',
    deeplinkTpl: null,
    initials: 'BK',
    tint: '#C8A200',
  },
  {
    // Deferred in collectors (AWS WAF, spec §3) but present here on purpose:
    // §8's worked example is a three-way comparison and two retailers make a
    // degenerate winner/runner-up layout impossible to design against.
    id: 'zepto',
    name: 'Zepto',
    mode: 'quick',
    deeplinkTpl: null,
    initials: 'ZP',
    tint: '#6A2D8F',
  },
  {
    id: 'bigbasket',
    name: 'BigBasket',
    mode: 'quick',
    deeplinkTpl: null,
    initials: 'BB',
    tint: '#7A9E2E',
  },
  {
    id: 'myntra',
    name: 'Myntra',
    mode: 'fashion',
    deeplinkTpl: null,
    initials: 'MY',
    tint: '#C2185B',
  },
  {
    id: 'amazon',
    name: 'Amazon',
    mode: 'fashion',
    deeplinkTpl: null,
    initials: 'AZ',
    tint: '#B65E10',
  },
  {
    id: 'flipkart',
    name: 'Flipkart',
    mode: 'fashion',
    deeplinkTpl: null,
    initials: 'FK',
    tint: '#1B5FBF',
  },
] as const;

export const CATEGORIES: readonly Category[] = [
  { id: 'dairy', label: 'Dairy & eggs', mode: 'quick' },
  { id: 'staples', label: 'Atta, rice & dal', mode: 'quick' },
  { id: 'produce', label: 'Fruit & vegetables', mode: 'quick' },
  { id: 'snacks', label: 'Snacks & packaged food', mode: 'quick' },
  { id: 'beverages', label: 'Tea, coffee & drinks', mode: 'quick' },
  { id: 'household', label: 'Cleaning & household', mode: 'quick' },
  { id: 'tshirts', label: 'T-shirts', mode: 'fashion' },
  { id: 'shirts', label: 'Shirts', mode: 'fashion' },
  { id: 'jeans', label: 'Jeans & trousers', mode: 'fashion' },
  { id: 'kurtas', label: 'Kurtas & ethnic', mode: 'fashion' },
  { id: 'footwear', label: 'Footwear', mode: 'fashion' },
] as const;

export const BRANDS: readonly string[] = [
  'Levi’s',
  'Nike',
  'Puma',
  'Roadster',
  'H&M',
  'Jack & Jones',
  'Allen Solly',
  'U.S. Polo Assn.',
  'Fabindia',
  'Adidas',
] as const;

export const SIZES: readonly string[] = ['S', 'M', 'L', 'XL', 'XXL'] as const;

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

/** One retailer's listing of a catalog entry. */
export type SeedListing = {
  retailerId: string;
  price: number;
  mrp: number | null;
  /** Defaults to true. `false` is what creates the partial-stock basket. */
  inStock?: boolean;
  /**
   * Days of `price_daily` we actually hold. Defaults to 34. Anything under 30
   * forces the "Lowest in N days" honesty copy (spec §7).
   */
  historyDays?: number;
  /** Marks this listing as sitting at its recorded period low. */
  atPeriodLow?: boolean;
};

export type SeedProduct = {
  /** Stable key; product ids are `${retailerId}:${key}`. */
  key: string;
  name: string;
  brand: string | null;
  /** Fashion size, or null in quick mode. */
  size: string | null;
  /** Quick-commerce pack size, or null in fashion mode. */
  pack: string | null;
  category: string;
  mode: Mode;
  listings: SeedListing[];
};

export const PRODUCTS: readonly SeedProduct[] = [
  /* --- quick commerce ------------------------------------------------ */
  {
    key: 'amul-taaza-500',
    name: 'Amul Taaza Toned Milk',
    brand: 'Amul',
    size: null,
    pack: '500 ml',
    category: 'dairy',
    mode: 'quick',
    listings: [
      // The gap that stops Blinkit winning outright, even though it is cheapest
      // on almost everything else.
      { retailerId: 'blinkit', price: 28, mrp: 28, inStock: false },
      { retailerId: 'zepto', price: 28, mrp: 28 },
      { retailerId: 'bigbasket', price: 27, mrp: 28 },
    ],
  },
  {
    key: 'amul-butter-500',
    name: 'Amul Butter, salted',
    brand: 'Amul',
    size: null,
    pack: '500 g',
    category: 'dairy',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 285, mrp: 295 },
      { retailerId: 'zepto', price: 289, mrp: 295 },
      { retailerId: 'bigbasket', price: 279, mrp: 295, atPeriodLow: true },
    ],
  },
  {
    key: 'eggs-6',
    name: 'Farm Eggs, brown',
    brand: 'Keggs',
    size: null,
    pack: '6 pieces',
    category: 'dairy',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 72, mrp: 84 },
      { retailerId: 'zepto', price: 75, mrp: 84 },
      { retailerId: 'bigbasket', price: 69, mrp: 84 },
    ],
  },
  {
    key: 'aashirvaad-atta-5kg',
    name: 'Aashirvaad Shudh Chakki Atta',
    brand: 'Aashirvaad',
    size: null,
    pack: '5 kg',
    category: 'staples',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 265, mrp: 330 },
      { retailerId: 'zepto', price: 272, mrp: 330 },
      { retailerId: 'bigbasket', price: 259, mrp: 330 },
    ],
  },
  {
    key: 'bb-toor-dal-1kg',
    name: 'Tata Sampann Unpolished Toor Dal',
    brand: 'Tata Sampann',
    size: null,
    pack: '1 kg',
    category: 'staples',
    mode: 'quick',
    listings: [
      // Only 12 days of history: the UI must say "Lowest in 12 days" (spec §7).
      { retailerId: 'blinkit', price: 174, mrp: 245, historyDays: 12, atPeriodLow: true },
      { retailerId: 'zepto', price: 182, mrp: 245, historyDays: 12 },
      { retailerId: 'bigbasket', price: 179, mrp: 245, historyDays: 12 },
    ],
  },
  {
    key: 'india-gate-rice-5kg',
    name: 'India Gate Classic Basmati Rice',
    brand: 'India Gate',
    size: null,
    pack: '5 kg',
    category: 'staples',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 689, mrp: 950 },
      { retailerId: 'zepto', price: 705, mrp: 950 },
      { retailerId: 'bigbasket', price: 679, mrp: 950 },
    ],
  },
  {
    key: 'tomato-1kg',
    name: 'Tomato, local',
    brand: null,
    size: null,
    pack: '1 kg',
    category: 'produce',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 34, mrp: null },
      { retailerId: 'zepto', price: 32, mrp: null },
      { retailerId: 'bigbasket', price: 38, mrp: null },
    ],
  },
  {
    key: 'onion-1kg',
    name: 'Onion, Nashik',
    brand: null,
    size: null,
    pack: '1 kg',
    category: 'produce',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 41, mrp: null },
      { retailerId: 'zepto', price: 44, mrp: null },
      { retailerId: 'bigbasket', price: 39, mrp: null },
    ],
  },
  {
    key: 'banana-dozen',
    name: 'Banana, Robusta',
    brand: null,
    size: null,
    pack: '6 pieces',
    category: 'produce',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 46, mrp: null },
      { retailerId: 'zepto', price: 48, mrp: null },
      { retailerId: 'bigbasket', price: 44, mrp: null },
    ],
  },
  {
    key: 'maggi-8pack',
    name: 'Maggi 2-Minute Masala Noodles',
    brand: 'Maggi',
    size: null,
    pack: '8 x 70 g',
    category: 'snacks',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 108, mrp: 168, atPeriodLow: true },
      { retailerId: 'zepto', price: 118, mrp: 168 },
      { retailerId: 'bigbasket', price: 112, mrp: 168 },
    ],
  },
  {
    key: 'parle-g-800',
    name: 'Parle-G Gold Biscuits',
    brand: 'Parle',
    size: null,
    pack: '800 g',
    category: 'snacks',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 84, mrp: 100 },
      { retailerId: 'zepto', price: 86, mrp: 100 },
      { retailerId: 'bigbasket', price: 82, mrp: 100 },
    ],
  },
  {
    key: 'haldirams-bhujia-400',
    name: "Haldiram's Aloo Bhujia",
    brand: "Haldiram's",
    size: null,
    pack: '400 g',
    category: 'snacks',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 96, mrp: 145 },
      { retailerId: 'zepto', price: 99, mrp: 145 },
      { retailerId: 'bigbasket', price: 92, mrp: 145, atPeriodLow: true },
    ],
  },
  {
    key: 'tata-tea-gold-500',
    name: 'Tata Tea Gold Leaf',
    brand: 'Tata Tea',
    size: null,
    pack: '500 g',
    category: 'beverages',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 289, mrp: 375 },
      { retailerId: 'zepto', price: 295, mrp: 375 },
      { retailerId: 'bigbasket', price: 284, mrp: 375 },
    ],
  },
  {
    key: 'bru-instant-100',
    name: 'Bru Instant Coffee',
    brand: 'Bru',
    size: null,
    pack: '100 g',
    category: 'beverages',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 232, mrp: 320 },
      { retailerId: 'zepto', price: 239, mrp: 320, inStock: false },
      { retailerId: 'bigbasket', price: 228, mrp: 320 },
    ],
  },
  {
    key: 'surf-excel-2kg',
    name: 'Surf Excel Easy Wash Detergent Powder',
    brand: 'Surf Excel',
    size: null,
    pack: '2 kg',
    category: 'household',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 372, mrp: 545 },
      { retailerId: 'zepto', price: 389, mrp: 545 },
      { retailerId: 'bigbasket', price: 365, mrp: 545 },
    ],
  },
  {
    key: 'harpic-1l',
    name: 'Harpic Power Plus Toilet Cleaner',
    brand: 'Harpic',
    size: null,
    pack: '1 L',
    category: 'household',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 178, mrp: 235 },
      { retailerId: 'zepto', price: 182, mrp: 235 },
      { retailerId: 'bigbasket', price: 174, mrp: 235 },
    ],
  },
  {
    key: 'vim-bar-3',
    name: 'Vim Dishwash Bar',
    brand: 'Vim',
    size: null,
    pack: '3 x 200 g',
    category: 'household',
    mode: 'quick',
    listings: [
      { retailerId: 'blinkit', price: 58, mrp: 90, atPeriodLow: true },
      { retailerId: 'zepto', price: 62, mrp: 90 },
      { retailerId: 'bigbasket', price: 60, mrp: 90 },
    ],
  },

  /* --- fashion -------------------------------------------------------- */
  {
    key: 'roadster-tee-navy',
    name: 'Roadster Pure Cotton Round-Neck T-shirt',
    brand: 'Roadster',
    size: 'M',
    pack: null,
    category: 'tshirts',
    mode: 'fashion',
    listings: [
      { retailerId: 'myntra', price: 449, mrp: 1299, atPeriodLow: true },
      { retailerId: 'amazon', price: 599, mrp: 1299 },
      { retailerId: 'flipkart', price: 529, mrp: 1299 },
    ],
  },
  {
    key: 'nike-dri-fit-tee',
    name: 'Nike Dri-FIT Training T-shirt',
    brand: 'Nike',
    size: 'L',
    pack: null,
    category: 'tshirts',
    mode: 'fashion',
    listings: [
      { retailerId: 'myntra', price: 1349, mrp: 2295 },
      { retailerId: 'amazon', price: 1279, mrp: 2295 },
      { retailerId: 'flipkart', price: 1399, mrp: 2295, inStock: false },
    ],
  },
  {
    key: 'hm-oversized-tee',
    name: 'H&M Oversized Printed T-shirt',
    brand: 'H&M',
    size: 'M',
    pack: null,
    category: 'tshirts',
    mode: 'fashion',
    listings: [
      { retailerId: 'myntra', price: 699, mrp: 1499 },
      { retailerId: 'amazon', price: 749, mrp: 1499 },
    ],
  },
  {
    key: 'allen-solly-shirt',
    name: 'Allen Solly Slim Fit Formal Shirt',
    brand: 'Allen Solly',
    size: 'L',
    pack: null,
    category: 'shirts',
    mode: 'fashion',
    listings: [
      { retailerId: 'myntra', price: 1099, mrp: 2199 },
      { retailerId: 'amazon', price: 1249, mrp: 2199 },
      { retailerId: 'flipkart', price: 1049, mrp: 2199, historyDays: 12 },
    ],
  },
  {
    key: 'uspa-oxford-shirt',
    name: 'U.S. Polo Assn. Oxford Casual Shirt',
    brand: 'U.S. Polo Assn.',
    size: 'M',
    pack: null,
    category: 'shirts',
    mode: 'fashion',
    listings: [
      { retailerId: 'myntra', price: 1519, mrp: 2799 },
      { retailerId: 'flipkart', price: 1649, mrp: 2799 },
    ],
  },
  {
    key: 'levis-511-jeans',
    name: "Levi's 511 Slim Fit Jeans",
    brand: 'Levi’s',
    size: 'L',
    pack: null,
    category: 'jeans',
    mode: 'fashion',
    listings: [
      { retailerId: 'myntra', price: 2099, mrp: 3999 },
      { retailerId: 'amazon', price: 1999, mrp: 3999, atPeriodLow: true },
      { retailerId: 'flipkart', price: 2249, mrp: 3999 },
    ],
  },
  {
    key: 'jack-jones-chinos',
    name: 'Jack & Jones Slim Fit Chinos',
    brand: 'Jack & Jones',
    size: 'M',
    pack: null,
    category: 'jeans',
    mode: 'fashion',
    listings: [
      { retailerId: 'myntra', price: 1399, mrp: 3499 },
      { retailerId: 'amazon', price: 1599, mrp: 3499 },
    ],
  },
  {
    key: 'fabindia-kurta',
    name: 'Fabindia Handloom Cotton Kurta',
    brand: 'Fabindia',
    size: 'XL',
    pack: null,
    category: 'kurtas',
    mode: 'fashion',
    listings: [
      { retailerId: 'myntra', price: 1749, mrp: 2490 },
      { retailerId: 'amazon', price: 1890, mrp: 2490 },
      { retailerId: 'flipkart', price: 1820, mrp: 2490 },
    ],
  },
  {
    key: 'puma-smash-sneakers',
    name: 'Puma Smash V2 Leather Sneakers',
    brand: 'Puma',
    size: 'L',
    pack: null,
    category: 'footwear',
    mode: 'fashion',
    listings: [
      { retailerId: 'myntra', price: 2399, mrp: 4499 },
      { retailerId: 'amazon', price: 2249, mrp: 4499 },
      { retailerId: 'flipkart', price: 2599, mrp: 4499 },
    ],
  },
  {
    key: 'adidas-runfalcon',
    name: 'Adidas Runfalcon 3.0 Running Shoes',
    brand: 'Adidas',
    size: 'XL',
    pack: null,
    category: 'footwear',
    mode: 'fashion',
    listings: [
      { retailerId: 'myntra', price: 2799, mrp: 4999, atPeriodLow: true },
      { retailerId: 'amazon', price: 2949, mrp: 4999 },
      { retailerId: 'flipkart', price: 3099, mrp: 4999, inStock: false },
    ],
  },
] as const;

/* ------------------------------------------------------------------ */
/* Baskets                                                             */
/* ------------------------------------------------------------------ */

/** What the user actually buys every week — the regulars the Basket screen prices. */
export const BASKET_KEYS: Record<Mode, { key: string; label: string; qty: number }[]> = {
  quick: [
    { key: 'amul-taaza-500', label: 'Amul Taaza 500 ml', qty: 2 },
    { key: 'amul-butter-500', label: 'Amul Butter 500 g', qty: 1 },
    { key: 'eggs-6', label: 'Eggs, 6 pack', qty: 2 },
    { key: 'aashirvaad-atta-5kg', label: 'Aashirvaad Atta 5 kg', qty: 1 },
    { key: 'bb-toor-dal-1kg', label: 'Toor dal 1 kg', qty: 1 },
    { key: 'tomato-1kg', label: 'Tomato 1 kg', qty: 1 },
    { key: 'maggi-8pack', label: 'Maggi, 8 pack', qty: 1 },
  ],
  fashion: [
    { key: 'roadster-tee-navy', label: 'Plain navy tee, M', qty: 1 },
    { key: 'levis-511-jeans', label: "Levi's 511, L", qty: 1 },
    { key: 'puma-smash-sneakers', label: 'White sneakers, L', qty: 1 },
  ],
};

/** Per-retailer fees, as the user would have typed them into Settings (spec §8). */
export const DEMO_FEES: Record<string, { deliveryFee: number; handlingFee: number }> = {
  blinkit: { deliveryFee: 30, handlingFee: 9 },
  zepto: { deliveryFee: 25, handlingFee: 12 },
  bigbasket: { deliveryFee: 40, handlingFee: 0 },
  myntra: { deliveryFee: 0, handlingFee: 0 },
  amazon: { deliveryFee: 0, handlingFee: 0 },
  flipkart: { deliveryFee: 49, handlingFee: 0 },
};

/** Advertised delivery windows, in minutes. Fashion retailers advertise none. */
export const DEMO_ETA: Record<string, number | null> = {
  blinkit: 11,
  zepto: 9,
  bigbasket: 120,
  myntra: null,
  amazon: null,
  flipkart: null,
};

/* ------------------------------------------------------------------ */
/* Price history                                                       */
/* ------------------------------------------------------------------ */

/** Small deterministic hash, so a given product always draws the same curve. */
function seedOf(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** xorshift32 — fine for a fake price walk and stable across reloads. */
function nextRandom(state: number): { value: number; state: number } {
  let next = state;
  next ^= next << 13;
  next >>>= 0;
  next ^= next >> 17;
  next ^= next << 5;
  next >>>= 0;
  return { value: next / 4294967296, state: next };
}

function isoDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Builds `days` of `price_daily` ending at `currentPrice`. The walk drifts
 * gently upward into the past so today usually looks like a good day, but
 * `atPeriodLow` is what actually decides whether today *is* the low — the
 * curve is decoration, the flag is the claim.
 */
export function buildHistory(
  productId: string,
  currentPrice: number,
  days: number,
  atPeriodLow: boolean,
  now: number = Date.now()
): PricePoint[] {
  const points: PricePoint[] = [];
  let state = seedOf(productId) || 1;
  // Walk backwards from today, then reverse: the last point must be today's price.
  let price = currentPrice;

  for (let back = 0; back < days; back += 1) {
    const day = isoDay(now - back * DAY);
    const spread = Math.max(1, Math.round(price * 0.015));
    points.push({
      day,
      minPrice: Math.round(price),
      maxPrice: Math.round(price) + spread,
    });

    const drawn = nextRandom(state);
    state = drawn.state;
    // Older days sit above today when today is a genuine low; otherwise the
    // walk wanders both ways so "lowest" stays a meaningful claim.
    const drift = atPeriodLow ? drawn.value * 0.05 : (drawn.value - 0.45) * 0.06;
    price = Math.max(1, price * (1 + drift));
  }

  return points.reverse();
}

export function findProduct(key: string): SeedProduct | undefined {
  return PRODUCTS.find((product) => product.key === key);
}

export function retailerById(id: string): Retailer | undefined {
  return RETAILERS.find((retailer) => retailer.id === id);
}

export function retailersFor(mode: Mode): Retailer[] {
  return RETAILERS.filter((retailer) => retailer.mode === mode);
}

export function categoriesFor(mode: Mode): Category[] {
  return CATEGORIES.filter((category) => category.mode === mode);
}
