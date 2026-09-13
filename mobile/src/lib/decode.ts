/**
 * The anti-corruption layer between the Cloudflare Worker's wire format and
 * this app's domain types.
 *
 * The Worker's shapes (snake_case, per-retailer basket nesting, a `period_low`
 * object per item) are the contract — they are what the server actually sends.
 * The domain types in `./types.ts` are what the screens are built against:
 * camelCase, flattened for rendering, epoch milliseconds. Neither side bends;
 * this file translates, and it is the only place that knows both.
 *
 * Two rules govern everything below, and both exist because this app shows
 * money:
 *
 * 1. **A missing or malformed field is a `parse` ApiError, never a default.**
 *    A wrong price on screen is the worst failure this app has. An error state
 *    the user can see beats a number they will trust and act on. The only
 *    values allowed a default are ones whose ABSENCE is a legitimate server
 *    state (an unset pref, a product with no MRP, a mode never swept) — and
 *    each of those is called out where it happens.
 *
 * 2. **The honesty rule (spec §7) survives the mapping.** The Worker sends
 *    `days_observed` and a `claim` string with every period low. The real N is
 *    carried through untouched. If `days_observed` is missing or malformed,
 *    this file raises rather than guessing — because the one guess that would
 *    be convenient here ("assume 30") is exactly the false claim the spec
 *    forbids. An absent `period_low` maps to "unknown", which the UI renders
 *    as no claim at all, never as a confident one.
 */

import { ApiError } from '@/lib/api-error';
import {
  type BasketComparison,
  type BasketItem,
  type BasketLine,
  type BasketQuote,
  type Category,
  type Deal,
  type DealsFeed,
  type Facets,
  type HealthReport,
  type Mode,
  type Offer,
  type PriceHistory,
  type PricePoint,
  type Prefs,
  type Retailer,
  type RetailerHealth,
  DEFAULT_PREFS,
} from '@/lib/types';

/* ------------------------------------------------------------------ */
/* Primitive readers                                                   */
/* ------------------------------------------------------------------ */

/**
 * `what` is the user-facing noun ("basket", "price history"); `path` is the
 * developer-facing location, which is attached as `cause` and never shown.
 */
export function parseFailure(what: string, path: string, detail: string): ApiError {
  return new ApiError(
    'parse',
    `The ${what} came back in a shape this app can't read. The server may be running a newer version of the Bachat API.`,
    { cause: new Error(`${path}: ${detail}`) }
  );
}

function rec(value: unknown, what: string, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw parseFailure(what, path, `expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function arr(value: unknown, what: string, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw parseFailure(what, path, `expected an array, got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/** A finite number. Rejects NaN, Infinity, and numeric strings alike. */
function reqNum(value: unknown, what: string, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw parseFailure(what, path, `expected a finite number, got ${describe(value)}`);
  }
  return value;
}

/** Null when absent; still rejected when present and not a finite number. */
function nullNum(value: unknown, what: string, path: string): number | null {
  if (isAbsent(value)) return null;
  return reqNum(value, what, path);
}

function reqStr(value: unknown, what: string, path: string): string {
  if (typeof value !== 'string') {
    throw parseFailure(what, path, `expected a string, got ${describe(value)}`);
  }
  return value;
}

function nullStr(value: unknown, what: string, path: string): string | null {
  if (isAbsent(value)) return null;
  const s = reqStr(value, what, path);
  return s.length > 0 ? s : null;
}

function reqBool(value: unknown, what: string, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw parseFailure(what, path, `expected a boolean, got ${describe(value)}`);
  }
  return value;
}

function reqMode(value: unknown, what: string, path: string): Mode {
  if (value !== 'quick' && value !== 'fashion') {
    throw parseFailure(what, path, `expected 'quick' or 'fashion', got ${describe(value)}`);
  }
  return value;
}

function strList(value: unknown, what: string, path: string): string[] {
  return arr(value, what, path).map((entry, i) => reqStr(entry, what, `${path}[${i}]`));
}

/**
 * Epoch **milliseconds**. The Worker stores and emits ms everywhere
 * (`worker/src/lib/dates.ts`), so a value small enough to be seconds is a unit
 * bug, not a variant to be quietly rescued: rescuing it is how a price ends up
 * labelled "56 years old" or, worse, "just now".
 */
const MIN_PLAUSIBLE_MS = 1e12; // 2001-09-09

function reqTimestamp(value: unknown, what: string, path: string): number {
  const n = reqNum(value, what, path);
  if (n < MIN_PLAUSIBLE_MS) {
    throw parseFailure(what, path, `expected epoch milliseconds, got ${n}`);
  }
  return n;
}

function nullTimestamp(value: unknown, what: string, path: string): number | null {
  if (isAbsent(value)) return null;
  return reqTimestamp(value, what, path);
}

/* ------------------------------------------------------------------ */
/* Period low — the honesty rule (spec §7)                             */
/* ------------------------------------------------------------------ */

/** The app-side view of the Worker's `period_low` object. */
export type PeriodLow = {
  periodLow: number | null;
  /** The REAL number of days of history behind the claim. 0 = unknown/none. */
  historyDays: number;
  isPeriodLow: boolean;
  /** The server's own wording, e.g. "lowest in 12 days". Null when unknown. */
  claim: string | null;
};

/** What a route that carries no history at all maps to: no claim, not a low. */
const UNKNOWN_PERIOD_LOW: PeriodLow = {
  periodLow: null,
  historyDays: 0,
  isPeriodLow: false,
  claim: null,
};

/**
 * Decodes `period_low`. An absent object means "this route doesn't carry
 * history" and yields {@link UNKNOWN_PERIOD_LOW}; a PRESENT but incomplete
 * one is a hard error, because the only field that could plausibly be defaulted
 * — `days_observed` — is the one the spec forbids guessing.
 */
export function decodePeriodLow(value: unknown, what: string, path: string): PeriodLow {
  if (isAbsent(value)) return UNKNOWN_PERIOD_LOW;
  const r = rec(value, what, path);

  const daysObserved = reqNum(r.days_observed, what, `${path}.days_observed`);
  if (!Number.isInteger(daysObserved) || daysObserved < 0) {
    throw parseFailure(
      what,
      `${path}.days_observed`,
      `expected a non-negative whole number of days, got ${daysObserved}`
    );
  }

  const isPeriodLow = reqBool(r.is_period_low, what, `${path}.is_period_low`);
  const claim = reqStr(r.claim, what, `${path}.claim`);

  // With no days observed there is nothing to be the low OF. A server that
  // claims one anyway is malformed, and letting it through would put
  // "lowest ever" on a product we have never priced before.
  if (daysObserved === 0 && isPeriodLow) {
    throw parseFailure(
      what,
      `${path}`,
      'claims a period low with days_observed = 0'
    );
  }

  return {
    periodLow: daysObserved === 0 ? null : reqNum(r.low_price, what, `${path}.low_price`),
    historyDays: daysObserved,
    isPeriodLow,
    claim,
  };
}

/* ------------------------------------------------------------------ */
/* Offers                                                              */
/* ------------------------------------------------------------------ */

type OfferSource = {
  /** Fallback when the row itself doesn't name a retailer (basket lines). */
  retailerId?: string;
  fallbackMode: Mode;
};

/**
 * One priced row -> one {@link Offer}. Shared by /api/deals, /api/compare and
 * the per-retailer lines of /api/basket, all of which emit the same core
 * columns; only `period_low` and `deeplink` vary by route.
 */
function decodeOffer(value: unknown, what: string, path: string, src: OfferSource): Offer {
  const r = rec(value, what, path);

  const retailerId = src.retailerId ?? reqStr(r.retailer_id, what, `${path}.retailer_id`);
  const deeplink = nullStr(r.deeplink, what, `${path}.deeplink`);
  const url = nullStr(r.url, what, `${path}.url`);
  const period = decodePeriodLow(r.period_low, what, `${path}.period_low`);

  return {
    productId: reqStr(r.product_id, what, `${path}.product_id`),
    retailerId,
    retailerName: nullStr(r.retailer_name, what, `${path}.retailer_name`) ?? undefined,
    name: reqStr(r.name, what, `${path}.name`),
    brand: nullStr(r.brand, what, `${path}.brand`),
    size: nullStr(r.size, what, `${path}.size`),
    pack: nullStr(r.pack, what, `${path}.pack`),
    imageUrl: nullStr(r.image_url, what, `${path}.image_url`),
    // A product with neither a URL nor a deep link simply isn't tappable; the
    // empty string is the honest answer and `buyUrl` does nothing with it.
    url: url ?? deeplink ?? '',
    deeplink,
    // `category` is nullable in D1 (products.category has no NOT NULL), so an
    // absent one is a real server state, not a broken payload.
    category: nullStr(r.category, what, `${path}.category`) ?? '',
    mode: isAbsent(r.mode) ? src.fallbackMode : reqMode(r.mode, what, `${path}.mode`),

    // Money and its age are never defaulted.
    price: reqNum(r.price, what, `${path}.price`),
    mrp: nullNum(r.mrp, what, `${path}.mrp`),
    inStock: reqBool(r.in_stock, what, `${path}.in_stock`),
    capturedAt: reqTimestamp(r.captured_at, what, `${path}.captured_at`),

    periodLow: period.periodLow,
    historyDays: period.historyDays,
    isPeriodLow: period.isPeriodLow,
    periodLowClaim: period.claim,
  };
}

/* ------------------------------------------------------------------ */
/* GET /api/health                                                     */
/* ------------------------------------------------------------------ */

const WHAT_HEALTH = 'health check';

export function decodeHealth(body: unknown): HealthReport {
  const r = rec(body, WHAT_HEALTH, 'health');

  const retailerHealth: RetailerHealth[] = arr(
    r.retailers,
    WHAT_HEALTH,
    'health.retailers'
  ).map((entry, i) => {
    const p = `health.retailers[${i}]`;
    const row = rec(entry, WHAT_HEALTH, p);
    return {
      id: reqStr(row.id, WHAT_HEALTH, `${p}.id`),
      name: reqStr(row.name, WHAT_HEALTH, `${p}.name`),
      mode: reqMode(row.mode, WHAT_HEALTH, `${p}.mode`),
      // Null is meaningful: this retailer has never been swept.
      lastSweepAt: nullTimestamp(row.last_sweep_at, WHAT_HEALTH, `${p}.last_sweep_at`),
      ageSeconds: nullNum(row.age_seconds, WHAT_HEALTH, `${p}.age_seconds`),
      stale: reqBool(row.stale, WHAT_HEALTH, `${p}.stale`),
      productCount: reqNum(row.product_count, WHAT_HEALTH, `${p}.product_count`),
    };
  });

  const modes = rec(r.modes, WHAT_HEALTH, 'health.modes');
  const modeSweep = (mode: Mode): number | null => {
    const m = rec(modes[mode], WHAT_HEALTH, `health.modes.${mode}`);
    return nullTimestamp(m.last_sweep_at, WHAT_HEALTH, `health.modes.${mode}.last_sweep_at`);
  };

  const status = reqStr(r.status, WHAT_HEALTH, 'health.status');
  if (status !== 'ok' && status !== 'degraded') {
    throw parseFailure(WHAT_HEALTH, 'health.status', `unknown status '${status}'`);
  }

  return {
    status,
    lastSweepAt: { quick: modeSweep('quick'), fashion: modeSweep('fashion') },
    staleSweep: reqBool(r.stale_sweep, WHAT_HEALTH, 'health.stale_sweep'),
    products: reqNum(r.product_count, WHAT_HEALTH, 'health.product_count'),
    retailers: reqNum(r.retailer_count, WHAT_HEALTH, 'health.retailer_count'),
    lastPushSentAt: nullTimestamp(r.last_push_sent_at, WHAT_HEALTH, 'health.last_push_sent_at'),
    retailerHealth,
    serverNow: nullTimestamp(r.now, WHAT_HEALTH, 'health.now'),
  };
}

/* ------------------------------------------------------------------ */
/* GET /api/basket                                                     */
/* ------------------------------------------------------------------ */

const WHAT_BASKET = 'basket';

/** Sorts quotes the way §8 requires: fully stocked first, then cheapest total. */
export function rankQuotes(quotes: BasketQuote[]): BasketQuote[] {
  return [...quotes].sort((a, b) => {
    if (a.fullyStocked !== b.fullyStocked) return a.fullyStocked ? -1 : 1;
    return a.total - b.total;
  });
}

function decodeBasketItem(value: unknown, path: string, fallbackMode: Mode): BasketItem {
  const r = rec(value, WHAT_BASKET, path);
  const qty = reqNum(r.qty, WHAT_BASKET, `${path}.qty`);
  return {
    id: reqStr(r.basket_item_id ?? r.id, WHAT_BASKET, `${path}.basket_item_id`),
    label: reqStr(r.label, WHAT_BASKET, `${path}.label`),
    qty: Math.max(1, Math.round(qty)),
    mode: isAbsent(r.mode) ? fallbackMode : reqMode(r.mode, WHAT_BASKET, `${path}.mode`),
    category: nullStr(r.category, WHAT_BASKET, `${path}.category`) ?? '',
  };
}

/** POST /api/basket (action=replace) -> the stored basket. */
export function decodeBasketItems(body: unknown, mode: Mode): BasketItem[] {
  const r = rec(body, WHAT_BASKET, 'basket');
  return arr(r.items, WHAT_BASKET, 'basket.items').map((entry, i) =>
    decodeBasketItem(entry, `basket.items[${i}]`, mode)
  );
}

/**
 * The Worker groups by retailer (`retailers[].lines[]`); the screens render by
 * basket item (`lines[].offers[]`). This pivots one into the other, which is
 * the single largest shape difference between the two sides.
 */
export function decodeBasket(body: unknown, requestedMode: Mode): BasketComparison {
  const r = rec(body, WHAT_BASKET, 'basket');
  const mode = isAbsent(r.mode) ? requestedMode : reqMode(r.mode, WHAT_BASKET, 'basket.mode');

  const items = arr(r.items, WHAT_BASKET, 'basket.items').map((entry, i) =>
    decodeBasketItem(entry, `basket.items[${i}]`, mode)
  );

  /** basket_item_id -> every retailer's offer for it. */
  const offersByItem = new Map<string, Offer[]>();
  const quotes: BasketQuote[] = [];

  arr(r.retailers, WHAT_BASKET, 'basket.retailers').forEach((entry, i) => {
    const p = `basket.retailers[${i}]`;
    const row = rec(entry, WHAT_BASKET, p);
    const retailerId = reqStr(row.retailer_id, WHAT_BASKET, `${p}.retailer_id`);

    const ages: number[] = [];
    arr(row.lines, WHAT_BASKET, `${p}.lines`).forEach((lineEntry, j) => {
      const lp = `${p}.lines[${j}]`;
      const line = rec(lineEntry, WHAT_BASKET, lp);
      const status = reqStr(line.status, WHAT_BASKET, `${lp}.status`);
      if (status === 'missing') return;
      if (status !== 'priced') {
        throw parseFailure(WHAT_BASKET, `${lp}.status`, `unknown line status '${status}'`);
      }
      const itemId = reqStr(line.basket_item_id, WHAT_BASKET, `${lp}.basket_item_id`);
      // /api/basket carries no price history, so every offer here is honestly
      // "unknown" on the period low rather than falsely "not a low".
      const offer = decodeOffer(line, WHAT_BASKET, lp, { retailerId, fallbackMode: mode });
      ages.push(offer.capturedAt);
      const list = offersByItem.get(itemId) ?? [];
      list.push(offer);
      offersByItem.set(itemId, list);
    });

    const missing = arr(row.missing_items, WHAT_BASKET, `${p}.missing_items`).map((m, k) => {
      const mp = `${p}.missing_items[${k}]`;
      const mr = rec(m, WHAT_BASKET, mp);
      return reqStr(mr.label, WHAT_BASKET, `${mp}.label`);
    });

    quotes.push({
      retailerId,
      retailerName: nullStr(row.retailer_name, WHAT_BASKET, `${p}.retailer_name`) ?? undefined,
      // The Worker's `subtotal` is the money; its `items_total` is a COUNT of
      // basket items. Reading `items_total` as a rupee figure — the obvious
      // name-match — would put an item count where a price belongs.
      itemsTotal: reqNum(row.subtotal, WHAT_BASKET, `${p}.subtotal`),
      deliveryFee: reqNum(row.delivery_fee, WHAT_BASKET, `${p}.delivery_fee`),
      handlingFee: reqNum(row.handling_fee, WHAT_BASKET, `${p}.handling_fee`),
      total: reqNum(row.basket_total, WHAT_BASKET, `${p}.basket_total`),
      inStockCount: reqNum(row.items_matched, WHAT_BASKET, `${p}.items_matched`),
      itemCount: reqNum(row.items_total, WHAT_BASKET, `${p}.items_total`),
      missing,
      etaMinutes: nullNum(row.eta_minutes, WHAT_BASKET, `${p}.eta_minutes`),
      // The honest age of this quote is its OLDEST line, not its newest.
      capturedAt: ages.length > 0 ? Math.min(...ages) : 0,
      fullyStocked: reqBool(row.fully_stocked, WHAT_BASKET, `${p}.fully_stocked`),
    });
  });

  const ranked = rankQuotes(quotes);
  const stocked = ranked.filter((q) => q.fullyStocked);

  const ranking = rec(r.ranking, WHAT_BASKET, 'basket.ranking');
  const winnerId = isAbsent(ranking.winner)
    ? null
    : reqStr(
        rec(ranking.winner, WHAT_BASKET, 'basket.ranking.winner').retailer_id,
        WHAT_BASKET,
        'basket.ranking.winner.retailer_id'
      );
  const runnerUpId = isAbsent(ranking.runner_up)
    ? null
    : reqStr(
        rec(ranking.runner_up, WHAT_BASKET, 'basket.ranking.runner_up').retailer_id,
        WHAT_BASKET,
        'basket.ranking.runner_up.retailer_id'
      );

  // Trust the server's ranking, but never let a partially stocked retailer win
  // (spec §8) even if a future server bug names one.
  const winner = stocked.find((q) => q.retailerId === winnerId) ?? null;
  const runnerUp =
    stocked.find((q) => q.retailerId === runnerUpId && q.retailerId !== winner?.retailerId) ??
    null;

  const saving = nullNum(ranking.winner_saving, WHAT_BASKET, 'basket.ranking.winner_saving');

  const lines: BasketLine[] = items.map((item) => ({
    item,
    offers: offersByItem.get(item.id) ?? [],
  }));

  const allAges = quotes.map((q) => q.capturedAt).filter((v) => v > 0);

  return {
    mode,
    lines,
    quotes: ranked,
    winnerRetailerId: winner?.retailerId ?? null,
    runnerUpRetailerId: runnerUp?.retailerId ?? null,
    savingVsRunnerUp:
      winner && runnerUp ? (saving ?? Math.max(0, runnerUp.total - winner.total)) : null,
    capturedAt: allAges.length > 0 ? Math.min(...allAges) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* GET /api/deals                                                      */
/* ------------------------------------------------------------------ */

const WHAT_DEALS = 'deals feed';

export function decodeDeals(body: unknown, requestedMode: Mode): DealsFeed {
  const r = rec(body, WHAT_DEALS, 'deals');
  const mode = isAbsent(r.mode) ? requestedMode : reqMode(r.mode, WHAT_DEALS, 'deals.mode');

  const deals: Deal[] = arr(r.items, WHAT_DEALS, 'deals.items').map((entry, i) => {
    const p = `deals.items[${i}]`;
    const row = rec(entry, WHAT_DEALS, p);
    const offer = decodeOffer(row, WHAT_DEALS, p, { fallbackMode: mode });
    const discountPct = nullNum(row.discount_pct, WHAT_DEALS, `${p}.discount_pct`);

    return {
      // A period low is the stronger, more specific claim, so it wins the
      // badge when an offer qualifies on both counts.
      kind: offer.isPeriodLow ? 'period-low' : 'threshold',
      offer,
      discountPct,
      savedAmount: offer.mrp === null ? null : Math.max(0, offer.mrp - offer.price),
    };
  });

  const ages = deals.map((d) => d.offer.capturedAt);

  return {
    mode,
    deals,
    // `swept_at` is null only when the page is empty; 0 then means "no sweep",
    // which is what the staleness chip already renders as unknown.
    sweptAt:
      nullTimestamp(r.swept_at, WHAT_DEALS, 'deals.swept_at') ??
      (ages.length > 0 ? Math.max(...ages) : 0),
    nextCursor: nullStr(r.next_cursor, WHAT_DEALS, 'deals.next_cursor'),
  };
}

/* ------------------------------------------------------------------ */
/* GET /api/compare                                                    */
/* ------------------------------------------------------------------ */

const WHAT_COMPARE = 'search results';

export function decodeCompare(
  body: unknown,
  requestedMode: Mode,
  requestedQuery: string
): { mode: Mode; query: string; offers: Offer[]; sweptAt: number } {
  const r = rec(body, WHAT_COMPARE, 'compare');
  const mode = isAbsent(r.mode) ? requestedMode : reqMode(r.mode, WHAT_COMPARE, 'compare.mode');

  // The Worker calls this list `results`; the app calls it `offers`. Reading
  // the app's name off the wire silently yields an empty screen.
  const offers = arr(r.results, WHAT_COMPARE, 'compare.results').map((entry, i) =>
    decodeOffer(entry, WHAT_COMPARE, `compare.results[${i}]`, { fallbackMode: mode })
  );

  offers.sort((a, b) => {
    if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
    return a.price - b.price;
  });

  const ages = offers.map((o) => o.capturedAt);

  return {
    mode,
    query: isAbsent(r.query) ? requestedQuery : reqStr(r.query, WHAT_COMPARE, 'compare.query'),
    offers,
    sweptAt:
      nullTimestamp(r.swept_at, WHAT_COMPARE, 'compare.swept_at') ??
      (ages.length > 0 ? Math.max(...ages) : 0),
  };
}

/* ------------------------------------------------------------------ */
/* GET /api/history/:productId                                         */
/* ------------------------------------------------------------------ */

const WHAT_HISTORY = 'price history';

export function decodeHistory(body: unknown, requestedProductId: string): PriceHistory {
  const r = rec(body, WHAT_HISTORY, 'history');

  const points: PricePoint[] = arr(r.series, WHAT_HISTORY, 'history.series').map((entry, i) => {
    const p = `history.series[${i}]`;
    const row = rec(entry, WHAT_HISTORY, p);
    return {
      day: reqStr(row.day, WHAT_HISTORY, `${p}.day`),
      minPrice: reqNum(row.min_price, WHAT_HISTORY, `${p}.min_price`),
      maxPrice: reqNum(row.max_price, WHAT_HISTORY, `${p}.max_price`),
    };
  });

  // THE honesty field (spec §7). It is required, and it is never inferred from
  // `days_requested` — that is precisely how "lowest in 12 days" would become
  // a false "30-day low".
  const days = reqNum(r.days_observed, WHAT_HISTORY, 'history.days_observed');
  if (!Number.isInteger(days) || days < 0) {
    throw parseFailure(
      WHAT_HISTORY,
      'history.days_observed',
      `expected a non-negative whole number of days, got ${days}`
    );
  }
  if (days !== points.length) {
    throw parseFailure(
      WHAT_HISTORY,
      'history.days_observed',
      `says ${days} days but the series holds ${points.length}`
    );
  }

  const period = decodePeriodLow(r.period_low, WHAT_HISTORY, 'history.period_low');
  if (period.claim !== null && period.historyDays !== days) {
    throw parseFailure(
      WHAT_HISTORY,
      'history.period_low.days_observed',
      `disagrees with history.days_observed (${period.historyDays} vs ${days})`
    );
  }

  const lows = points.map((p) => p.minPrice);
  const highs = points.map((p) => p.maxPrice);

  return {
    productId: isAbsent(r.product_id)
      ? requestedProductId
      : reqStr(r.product_id, WHAT_HISTORY, 'history.product_id'),
    points,
    days,
    low: period.periodLow ?? (lows.length > 0 ? Math.min(...lows) : 0),
    high: highs.length > 0 ? Math.max(...highs) : 0,
    daysRequested: nullNum(r.days_requested, WHAT_HISTORY, 'history.days_requested'),
    currentPrice: nullNum(r.current_price, WHAT_HISTORY, 'history.current_price'),
    currentCapturedAt: nullTimestamp(
      r.current_captured_at,
      WHAT_HISTORY,
      'history.current_captured_at'
    ),
    isPeriodLow: period.isPeriodLow,
    periodLowClaim: period.claim,
  };
}

/* ------------------------------------------------------------------ */
/* GET /api/facets                                                     */
/* ------------------------------------------------------------------ */

const WHAT_FACETS = 'filter options';

/** Retailer brand marks. Presentation only — never derived from server data. */
const RETAILER_TINT: Record<string, string> = {
  blinkit: '#F8CB46',
  bigbasket: '#84C225',
  instamart: '#FC8019',
  zepto: '#5B2C8D',
  myntra: '#FF3F6C',
  amazon: '#FF9900',
  flipkart: '#2874F0',
};

const FALLBACK_TINT = '#111C18';

function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
}

/** 'personal-care' -> 'Personal care'. The Worker stores slugs, not labels. */
function labelForCategory(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words.length === 0 ? id : words.charAt(0).toUpperCase() + words.slice(1);
}

export function decodeRetailer(value: unknown, path: string, fallbackMode: Mode): Retailer {
  const r = rec(value, WHAT_FACETS, path);
  const name = reqStr(r.name, WHAT_FACETS, `${path}.name`);
  const id = reqStr(r.id, WHAT_FACETS, `${path}.id`);
  return {
    id,
    name,
    mode: isAbsent(r.mode) ? fallbackMode : reqMode(r.mode, WHAT_FACETS, `${path}.mode`),
    deeplinkTpl: nullStr(r.deeplink_tpl, WHAT_FACETS, `${path}.deeplink_tpl`),
    initials: initialsFor(name),
    tint: RETAILER_TINT[id] ?? FALLBACK_TINT,
  };
}

/**
 * GET /api/categories -> the sweepable catalog.
 *
 * Deliberately not the same source as `decodeFacets().categories`. Facets are
 * derived from rows already in `products`, so for a mode nothing has been
 * swept for yet the list comes back empty — and a Settings picker fed from it
 * cannot offer the categories needed to collect the products that would fill
 * it. That deadlock is why this exists.
 *
 * Labels here are the Worker's own, from the `categories` table, so unlike the
 * facets path nothing is derived from the slug. That matters: the table says
 * "Men's Tops", and a slug-derived label would render "Fashion-tops".
 */
export function decodeCategories(body: unknown): Category[] {
  const r = rec(body, WHAT_FACETS, 'categories');
  return arr(r.categories, WHAT_FACETS, 'categories.categories').map((entry, i) => {
    const p = `categories.categories[${i}]`;
    const row = rec(entry, WHAT_FACETS, p);
    const id = reqStr(row.slug, WHAT_FACETS, `${p}.slug`);
    return {
      id,
      label: isAbsent(row.label) ? labelForCategory(id) : reqStr(row.label, WHAT_FACETS, `${p}.label`),
      mode: reqMode(row.mode, WHAT_FACETS, `${p}.mode`),
    };
  });
}

export function decodeFacets(body: unknown, requestedMode: Mode): Facets {
  const r = rec(body, WHAT_FACETS, 'facets');
  const mode = isAbsent(r.mode) ? requestedMode : reqMode(r.mode, WHAT_FACETS, 'facets.mode');

  const categories: Category[] = arr(r.categories, WHAT_FACETS, 'facets.categories').map(
    (entry, i) => {
      const p = `facets.categories[${i}]`;
      const row = rec(entry, WHAT_FACETS, p);
      const id = reqStr(row.id, WHAT_FACETS, `${p}.id`);
      return {
        id,
        // The Worker has no display names for categories — they are slugs in
        // `products.category` — so the label is presentation, derived here.
        label: labelForCategory(id),
        mode: isAbsent(row.mode) ? mode : reqMode(row.mode, WHAT_FACETS, `${p}.mode`),
        productCount: nullNum(row.product_count, WHAT_FACETS, `${p}.product_count`) ?? undefined,
      };
    }
  );

  return {
    mode,
    retailers: arr(r.retailers, WHAT_FACETS, 'facets.retailers').map((entry, i) =>
      decodeRetailer(entry, `facets.retailers[${i}]`, mode)
    ),
    categories,
    brands: strList(r.brands, WHAT_FACETS, 'facets.brands'),
    sizes: strList(r.sizes, WHAT_FACETS, 'facets.sizes'),
  };
}

/* ------------------------------------------------------------------ */
/* /api/prefs                                                          */
/* ------------------------------------------------------------------ */

const WHAT_PREFS = 'settings';
const FEE_PREFIX = 'fees.';

/**
 * "23:00" or 23 -> 23. Prefs are the one place where absence is routine (a key
 * the user has never set), so an absent value falls back to the documented
 * default; a present-but-unreadable one still raises.
 */
function decodeHour(value: unknown, path: string, fallback: number): number {
  if (isAbsent(value)) return fallback;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 23) {
      throw parseFailure(WHAT_PREFS, path, `expected an hour 0-23, got ${value}`);
    }
    return Math.floor(value);
  }
  const text = reqStr(value, WHAT_PREFS, path);
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(text.trim());
  const hour = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
    throw parseFailure(WHAT_PREFS, path, `expected an 'HH:MM' hour, got '${text}'`);
  }
  return hour;
}

/** GET/POST /api/prefs -> {@link Prefs}. The wire side is a flat key/value map. */
export function decodePrefs(body: unknown): Prefs {
  const outer = rec(body, WHAT_PREFS, 'prefs');
  const map = rec(outer.prefs ?? outer, WHAT_PREFS, 'prefs.prefs');

  const quiet = isAbsent(map.quiet_hours)
    ? {}
    : rec(map.quiet_hours, WHAT_PREFS, 'prefs.quiet_hours');
  const location = isAbsent(map.location)
    ? {}
    : rec(map.location, WHAT_PREFS, 'prefs.location');

  const fees: Prefs['fees'] = {};
  for (const [key, value] of Object.entries(map)) {
    if (!key.startsWith(FEE_PREFIX)) continue;
    const retailerId = key.slice(FEE_PREFIX.length);
    const p = `prefs.${key}`;
    const fee = rec(value, WHAT_PREFS, p);
    fees[retailerId] = {
      deliveryFee: nullNum(fee.delivery, WHAT_PREFS, `${p}.delivery`) ?? 0,
      handlingFee: nullNum(fee.handling, WHAT_PREFS, `${p}.handling`) ?? 0,
    };
  }

  return {
    threshold:
      nullNum(map.threshold_pct, WHAT_PREFS, 'prefs.threshold_pct') ?? DEFAULT_PREFS.threshold,
    enabledCategories: isAbsent(map.enabled_categories)
      ? []
      : strList(map.enabled_categories, WHAT_PREFS, 'prefs.enabled_categories'),
    quietHours: {
      start: decodeHour(quiet.start, 'prefs.quiet_hours.start', DEFAULT_PREFS.quietHours.start),
      end: decodeHour(quiet.end, 'prefs.quiet_hours.end', DEFAULT_PREFS.quietHours.end),
    },
    pincode: nullStr(location.pincode, WHAT_PREFS, 'prefs.location.pincode') ?? '',
    lat: nullNum(location.lat, WHAT_PREFS, 'prefs.location.lat'),
    lon: nullNum(location.lon, WHAT_PREFS, 'prefs.location.lon'),
    fees,
    notificationsEnabled: isAbsent(map.notifications_enabled)
      ? true
      : reqBool(map.notifications_enabled, WHAT_PREFS, 'prefs.notifications_enabled'),
  };
}

/**
 * {@link Prefs} -> the Worker's flat pref keys.
 *
 * Only the keys actually present in `partial` are emitted, so a settings
 * screen that edits one toggle does not rewrite the user's whole config. The
 * Worker merges object-valued keys one level deep, which is what keeps
 * `fees.*.eta_minutes` and `quiet_hours.tz` — neither of which this app has a
 * UI for — alive across a write.
 */
export function encodePrefs(partial: Partial<Prefs>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (partial.threshold !== undefined) out.threshold_pct = partial.threshold;
  if (partial.enabledCategories !== undefined) {
    out.enabled_categories = partial.enabledCategories;
  }
  if (partial.notificationsEnabled !== undefined) {
    out.notifications_enabled = partial.notificationsEnabled;
  }
  if (partial.quietHours !== undefined) {
    out.quiet_hours = {
      start: `${String(partial.quietHours.start).padStart(2, '0')}:00`,
      end: `${String(partial.quietHours.end).padStart(2, '0')}:00`,
    };
  }

  const location: Record<string, unknown> = {};
  if (partial.pincode !== undefined) location.pincode = partial.pincode;
  if (partial.lat !== undefined) location.lat = partial.lat;
  if (partial.lon !== undefined) location.lon = partial.lon;
  if (Object.keys(location).length > 0) out.location = location;

  if (partial.fees !== undefined) {
    for (const [retailerId, fee] of Object.entries(partial.fees)) {
      out[`${FEE_PREFIX}${retailerId}`] = {
        delivery: fee.deliveryFee,
        handling: fee.handlingFee,
      };
    }
  }

  return out;
}

/** POST /api/basket body for "replace the whole basket for this mode". */
export function encodeBasket(
  mode: Mode,
  items: { id?: string; label: string; qty: number; category: string }[]
): Record<string, unknown> {
  return {
    action: 'replace',
    mode,
    items: items.map((item) => ({
      basket_item_id: item.id,
      label: item.label,
      qty: item.qty,
      category: item.category === '' ? null : item.category,
    })),
  };
}
