/**
 * Shared domain types — the whole app's view of the Worker API.
 *
 * The Worker (spec §5, §8, §9) is being written in parallel, so treat every
 * shape below as provisional. They all live in this one file precisely so a
 * contract correction is a single-file edit: `src/lib/api.ts` decodes into
 * these types, `src/lib/fixture-client.ts` fabricates them, and no screen ever
 * touches a raw JSON body.
 *
 *   GET  /api/health          -> HealthReport
 *   GET  /api/basket          -> BasketComparison
 *   POST /api/basket          -> { items: BasketItem[] }
 *   GET  /api/deals           -> DealsFeed
 *   GET  /api/compare         -> CompareResult
 *   GET  /api/history/:id     -> PriceHistory
 *   GET  /api/facets          -> Facets
 *   POST /api/prefs           -> { prefs: Prefs }
 *   POST /api/register-device -> { ok: true }
 *
 * Convention: every timestamp in this file is **epoch milliseconds**, even
 * though D1 stores seconds. The client multiplies once at the boundary so no
 * component ever has to remember which unit it is holding.
 */

/* ------------------------------------------------------------------ */
/* Mode                                                                */
/* ------------------------------------------------------------------ */

/**
 * The global mode (spec §9). Selects which retailers, categories, deal feed
 * and alerts apply. Read it from `useMode()`, never from a prop drilled down.
 */
export type Mode = 'quick' | 'fashion';

export const MODES: readonly Mode[] = ['quick', 'fashion'] as const;

export const MODE_LABEL: Record<Mode, string> = {
  quick: 'Quick Commerce',
  fashion: 'Fashion',
};

/** The switch is narrow; these are the words that fit on the thumb. */
export const MODE_SHORT_LABEL: Record<Mode, string> = {
  quick: 'Quick',
  fashion: 'Fashion',
};

export const DEFAULT_MODE: Mode = 'quick';

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export type Retailer = {
  /** Stable slug, e.g. 'blinkit'. Also the key into `Prefs.fees`. */
  id: string;
  name: string;
  mode: Mode;
  /**
   * Deep-link template with a `{url}` placeholder, or the retailer's own app
   * scheme. Bachat only ever opens it — it never handles a cart (spec §9).
   */
  deeplinkTpl: string | null;
  /** Two letters for the retailer mark when no logo is available. */
  initials: string;
  /** Retailer's own brand colour, used only inside its badge. */
  tint: string;
};

export type Category = {
  /** Slug used by `Prefs.enabledCategories` and the Android channel id. */
  id: string;
  label: string;
  mode: Mode;
  /** How many products the catalog currently holds in this category. */
  productCount?: number;
};

/**
 * One retailer's current offer for one product: the join of `products` and the
 * latest row in `prices` (spec §5), plus the deal-engine verdict (spec §7).
 */
export type Offer = {
  /** `products.id`. Pass this to `history()`. */
  productId: string;
  retailerId: string;
  /** The retailer's display name when the route carried one. */
  retailerName?: string;
  name: string;
  brand: string | null;
  /** Fashion size ('M') or quick-commerce pack size ('500 ml'). */
  size: string | null;
  pack: string | null;
  imageUrl: string | null;
  /** Product page on the retailer's site — the deep-link target. */
  url: string;
  /**
   * The retailer's own app deep link, already substituted by the Worker from
   * `retailers.deeplink_tpl`. Null when the route does not carry one; prefer
   * it over `url` when opening the retailer (spec §9).
   */
  deeplink?: string | null;
  category: string;
  mode: Mode;

  price: number;
  mrp: number | null;
  inStock: boolean;
  /** Epoch ms of the sweep that observed this price. Never omit it in the UI. */
  capturedAt: number;

  /**
   * Honesty rule (spec §7). The lowest price Bachat has actually recorded, and
   * over how many days of real history. `historyDays` is the true N — say
   * "lowest in 12 days", never "30-day low", until the data exists.
   */
  periodLow: number | null;
  historyDays: number;
  /** True when `price <= periodLow` over `historyDays`. */
  isPeriodLow: boolean;
  /**
   * The server's own wording for the claim, e.g. "lowest in 12 days" or
   * "no price history yet". **Null means the route carried no history at
   * all** — render nothing, never a claim. Prefer this string over composing
   * one locally: it is the wording the spec §7 honesty rule is tested against.
   */
  periodLowClaim?: string | null;
};

/* ------------------------------------------------------------------ */
/* Basket (spec §8)                                                    */
/* ------------------------------------------------------------------ */

export type BasketItem = {
  id: string;
  /** What the user typed: 'Amul Taaza 500 ml'. */
  label: string;
  qty: number;
  mode: Mode;
  category: string;
};

/** Payload for POST /api/basket — `id` is server-assigned on create. */
export type BasketItemInput = {
  id?: string;
  label: string;
  qty: number;
  mode: Mode;
  category: string;
};

/** One basket item priced across every retailer that stocks it. */
export type BasketLine = {
  item: BasketItem;
  /** One entry per retailer that matched. A retailer absent here has no match. */
  offers: Offer[];
};

/**
 * One retailer's bid for the whole basket. Ranking is by `total`, and only a
 * `fullyStocked` retailer may win outright (spec §8).
 */
export type BasketQuote = {
  retailerId: string;
  /** Display name from the Worker, when it sent one. */
  retailerName?: string;
  /** Sum of `price * qty` over matched, in-stock items. */
  itemsTotal: number;
  /** From `Prefs.fees` — user-editable, never scraped (spec §8). */
  deliveryFee: number;
  handlingFee: number;
  /** `itemsTotal + deliveryFee + handlingFee`. Rank on this. */
  total: number;
  inStockCount: number;
  itemCount: number;
  /** `BasketItem.label`s this retailer cannot supply. Always state them. */
  missing: string[];
  /** Delivery estimate in minutes, when the retailer advertises one. */
  etaMinutes: number | null;
  /** Oldest `capturedAt` across this quote's offers — the honest age. */
  capturedAt: number;
  fullyStocked: boolean;
};

export type BasketComparison = {
  mode: Mode;
  lines: BasketLine[];
  /** Pre-sorted cheapest-first, fully-stocked retailers before partial ones. */
  quotes: BasketQuote[];
  /** Null when the basket is empty or nothing is fully stocked. */
  winnerRetailerId: string | null;
  /**
   * Saving against the **runner-up**, not the worst option (spec §8). Null
   * when there is no second fully-stocked retailer to compare against.
   */
  savingVsRunnerUp: number | null;
  runnerUpRetailerId: string | null;
  /** Oldest `capturedAt` anywhere in this comparison. */
  capturedAt: number;
};

/* ------------------------------------------------------------------ */
/* Deals (spec §7)                                                     */
/* ------------------------------------------------------------------ */

/** Why the engine surfaced this. Drives the badge copy on the deal card. */
export type DealKind = 'threshold' | 'period-low';

export type Deal = {
  kind: DealKind;
  offer: Offer;
  /** 0..1. Present whenever `offer.mrp` is known. */
  discountPct: number | null;
  /** `mrp - price` in rupees, or null when `mrp` is unknown. */
  savedAmount: number | null;
};

export type DealsFeed = {
  mode: Mode;
  deals: Deal[];
  /** Epoch ms the newest sweep for this mode completed. */
  sweptAt: number;
  /** Opaque cursor for the next page, or null at the end of the feed. */
  nextCursor?: string | null;
};

export type DealsQuery = {
  mode: Mode;
  /** Category slugs. Omit or leave empty for every enabled category. */
  categories?: string[];
  limit?: number;
  /** `DealsFeed.nextCursor` from the previous page. */
  cursor?: string;
};

/* ------------------------------------------------------------------ */
/* Compare (spec §9)                                                   */
/* ------------------------------------------------------------------ */

export type CompareQuery = {
  mode: Mode;
  query: string;
  /** Fashion only — pushed to Myntra's server-side facets (spec §3). */
  brands?: string[];
  sizes?: string[];
  maxPrice?: number;
};

export type CompareResult = {
  mode: Mode;
  query: string;
  /** Pre-sorted cheapest-first, in-stock before out-of-stock. */
  offers: Offer[];
  sweptAt: number;
};

/* ------------------------------------------------------------------ */
/* History (spec §5, §7)                                               */
/* ------------------------------------------------------------------ */

/** One row of `price_daily`. */
export type PricePoint = {
  /** 'YYYY-MM-DD' in IST. */
  day: string;
  minPrice: number;
  maxPrice: number;
};

export type PriceHistory = {
  productId: string;
  /** Oldest first. May be shorter than 30 — that is the point (spec §7). */
  points: PricePoint[];
  /** `points.length`. The honest N in "lowest in N days". */
  days: number;
  low: number;
  high: number;
  /** The window that was asked for. `days` is what actually exists. */
  daysRequested?: number | null;
  /** Latest observed price, straight from the `prices` table. */
  currentPrice?: number | null;
  currentCapturedAt?: number | null;
  /** True when `currentPrice` is at or below the low over `days` days. */
  isPeriodLow?: boolean;
  /** The server's wording, e.g. "lowest in 12 days". Null when unknown. */
  periodLowClaim?: string | null;
};

/* ------------------------------------------------------------------ */
/* Facets                                                              */
/* ------------------------------------------------------------------ */

/** Everything the filter UI needs for one mode, in one round trip. */
export type Facets = {
  mode: Mode;
  retailers: Retailer[];
  categories: Category[];
  /** Fashion only; empty in quick mode. */
  brands: string[];
  sizes: string[];
};

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

/** One retailer's sweep freshness, straight from `GET /api/health`. */
export type RetailerHealth = {
  id: string;
  name: string;
  mode: Mode;
  /** Epoch ms of its newest observation. Null when never swept. */
  lastSweepAt: number | null;
  ageSeconds: number | null;
  /** True when the sweep is older than that mode's cadence allows (spec §12). */
  stale: boolean;
  productCount: number;
};

export type HealthReport = {
  status: 'ok' | 'degraded';
  /** Epoch ms of the last successful sweep per mode. Null when never swept. */
  lastSweepAt: Record<Mode, number | null>;
  /** True when the newest sweep is older than the schedule allows (spec §12). */
  staleSweep: boolean;
  products: number;
  retailers: number;
  /** Delivery health (spec §10): last push the server sent. */
  lastPushSentAt: number | null;
  /** Per-retailer detail behind `staleSweep`, so Settings can name the culprit. */
  retailerHealth?: RetailerHealth[];
  /** The server's clock at the time of the reply, for honest age arithmetic. */
  serverNow?: number | null;
};

/* ------------------------------------------------------------------ */
/* Prefs (spec §5, §8, §9)                                             */
/* ------------------------------------------------------------------ */

export type RetailerFees = {
  deliveryFee: number;
  handlingFee: number;
};

export type QuietHours = {
  /** Hour of day, 0-23, IST. Wraps across midnight when start > end. */
  start: number;
  end: number;
};

export type Prefs = {
  /** Discount fraction that fires a threshold alert. 0..1 (spec §7). */
  threshold: number;
  /** Category slugs the user wants swept and alerted on. */
  enabledCategories: string[];
  quietHours: QuietHours;
  /** Dark-store resolution for quick commerce (spec §6). */
  pincode: string;
  lat: number | null;
  lon: number | null;
  /** Keyed by `Retailer.id`. Missing keys mean zero fees. */
  fees: Record<string, RetailerFees>;
  notificationsEnabled: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  threshold: 0.6,
  enabledCategories: [],
  quietHours: { start: 23, end: 8 },
  pincode: '',
  lat: null,
  lon: null,
  fees: {},
  notificationsEnabled: true,
};

/* ------------------------------------------------------------------ */
/* Local-only settings                                                 */
/* ------------------------------------------------------------------ */

/**
 * Device-local preferences. Distinct from {@link Prefs}, which the collector
 * also reads — these never leave the phone.
 */
export type LocalSettings = {
  haptics: boolean;
  /** Push token last handed to the Worker, so we re-register only on change. */
  pushToken: string | null;
  /** Epoch ms of the last push this device actually received (spec §10). */
  lastPushReceivedAt: number | null;
  /** Set once the user has walked the battery-optimisation step (spec §10). */
  batteryGuideDone: boolean;
};

export const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
  haptics: true,
  pushToken: null,
  lastPushReceivedAt: null,
  batteryGuideDone: false,
};

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** Base URL of the Cloudflare Worker. Overridable for a local `wrangler dev`. */
export const BACKEND_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? 'https://bachat.smartlearners.workers.dev';

/**
 * `EXPO_PUBLIC_DEMO=1` swaps the HTTP client for the fixture client, so every
 * screen can be built and demoed with no Worker deployed (spec §13).
 */
export const DEMO_MODE: boolean = process.env.EXPO_PUBLIC_DEMO === '1';
