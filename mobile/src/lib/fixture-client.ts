/**
 * An {@link ApiClient} backed by the demo catalog in ./fixtures.ts.
 *
 * Spec §13: "the API client is an interface with one real implementation, so
 * screens develop against a fixture client with no backend running." This is
 * that client. It is selected by `EXPO_PUBLIC_DEMO=1` (see ./client.ts) and is
 * the only thing standing between the screens agent and a deployed Worker.
 *
 * It behaves like a network client on purpose, because a screen that only ever
 * sees instant data never grows a loading state:
 *
 * - every call takes 180–420 ms and honours its `AbortSignal`
 * - cancelling rejects with the same `ApiError('network', …)` the HTTP client
 *   throws, so no screen needs a special demo branch
 * - basket writes and pref writes mutate in-memory state that survives until
 *   the app reloads, so editing the basket actually changes the comparison
 *
 * To exercise failure states, call `setFixtureFailure('timeout')` from a dev
 * menu or a temporary button; the next call rejects with that kind.
 */

import { ApiError, rankQuotes, type ApiClient } from '@/lib/api';
import {
  BASKET_KEYS,
  DEMO_ETA,
  DEMO_FEES,
  PRODUCTS,
  buildHistory,
  capturedAtFor,
  categoriesFor,
  findProduct,
  retailersFor,
  sweptAt,
  BRANDS,
  SIZES,
  type SeedListing,
  type SeedProduct,
} from '@/lib/fixtures';
import {
  DEFAULT_PREFS,
  type BasketComparison,
  type BasketItem,
  type BasketItemInput,
  type BasketLine,
  type BasketQuote,
  type CompareQuery,
  type CompareResult,
  type Deal,
  type DealsFeed,
  type DealsQuery,
  type Facets,
  type HealthReport,
  type Mode,
  type Offer,
  type PriceHistory,
  type Prefs,
} from '@/lib/types';

/** Feels like a round trip to Cloudflare without making anyone wait. */
const LATENCY_MS = { min: 180, max: 420 } as const;

/* ------------------------------------------------------------------ */
/* Injected failure, for building error states                         */
/* ------------------------------------------------------------------ */

type FixtureFailure = ApiError['kind'] | null;
let injectedFailure: FixtureFailure = null;

/** Makes the *next* fixture call fail with `kind`. Pass `null` to clear it. */
export function setFixtureFailure(kind: FixtureFailure): void {
  injectedFailure = kind;
}

const FAILURE_MESSAGE: Record<NonNullable<FixtureFailure>, string> = {
  timeout: "The price server didn't respond in time. Pull to refresh in a moment.",
  network:
    "Couldn't reach Bachat's price server. Check this device's connection — the last prices you saw are still on screen.",
  server: 'The price server returned an error (HTTP 500). Try again in a moment.',
  unavailable:
    "Bachat's server is up but hasn't finished its first sweep. Prices will appear once one completes.",
  parse:
    "The price data came back in a shape this app can't read. The server may be running a newer version of the Bachat API.",
};

/* ------------------------------------------------------------------ */
/* Transport simulation                                                */
/* ------------------------------------------------------------------ */

function settle<T>(produce: () => T, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError('network', 'The request was cancelled.'));
      return;
    }

    const delay =
      LATENCY_MS.min + Math.random() * (LATENCY_MS.max - LATENCY_MS.min);

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      const failure = injectedFailure;
      if (failure) {
        injectedFailure = null;
        reject(new ApiError(failure, FAILURE_MESSAGE[failure]));
        return;
      }
      try {
        resolve(produce());
      } catch (error) {
        reject(
          error instanceof ApiError
            ? error
            : new ApiError('parse', FAILURE_MESSAGE.parse, { cause: error })
        );
      }
    }, delay);

    function onAbort() {
      clearTimeout(timer);
      reject(new ApiError('network', 'The request was cancelled.'));
    }

    signal?.addEventListener('abort', onAbort);
  });
}

/* ------------------------------------------------------------------ */
/* Projection: seed data -> API types                                  */
/* ------------------------------------------------------------------ */

/** Display names, so demo offers carry the same `retailerName` the API sends. */
const RETAILER_NAME: Record<string, string> = {
  blinkit: 'Blinkit',
  bigbasket: 'BigBasket',
  myntra: 'Myntra',
  amazon: 'Amazon.in',
  flipkart: 'Flipkart',
};

function productIdOf(retailerId: string, key: string): string {
  return `${retailerId}:${key}`;
}

function toOffer(product: SeedProduct, listing: SeedListing, now: number): Offer {
  const historyDays = listing.historyDays ?? 34;
  const productId = productIdOf(listing.retailerId, product.key);
  const points = buildHistory(
    productId,
    listing.price,
    historyDays,
    listing.atPeriodLow ?? false,
    now
  );
  const periodLow = points.length > 0 ? Math.min(...points.map((p) => p.minPrice)) : null;

  const claimDays = Math.min(30, historyDays);
  const atLow = (listing.atPeriodLow ?? false) && (listing.inStock ?? true);

  return {
    productId,
    retailerId: listing.retailerId,
    retailerName: RETAILER_NAME[listing.retailerId] ?? listing.retailerId,
    name: product.name,
    brand: product.brand,
    size: product.size,
    pack: product.pack,
    imageUrl: null,
    url: `https://example.invalid/${listing.retailerId}/${product.key}`,
    deeplink: `${listing.retailerId}://product/${product.key}?utm_source=bachat`,
    category: product.category,
    mode: product.mode,
    price: listing.price,
    mrp: listing.mrp,
    inStock: listing.inStock ?? true,
    capturedAt: capturedAtFor(listing.retailerId, product.mode, now),
    periodLow,
    // `historyDays` is capped at 30 for the claim itself: we never say "lowest
    // in 34 days" when the engine only ever looks back 30 (spec §7).
    historyDays: claimDays,
    isPeriodLow: atLow,
    // Worded exactly as worker/src/lib/history.ts words it, so the demo client
    // exercises the same honesty-rule copy the real server sends (spec §7).
    periodLowClaim: atLow
      ? `lowest in ${claimDays} day${claimDays === 1 ? '' : 's'}`
      : `not a period low (last ${claimDays} day${claimDays === 1 ? '' : 's'})`,
  };
}

function offersFor(product: SeedProduct, now: number): Offer[] {
  return product.listings.map((listing) => toOffer(product, listing, now));
}

/* ------------------------------------------------------------------ */
/* Basket                                                              */
/* ------------------------------------------------------------------ */

/** In-memory basket, seeded from fixtures and mutated by `saveBasket`. */
const basketState: Record<Mode, BasketItem[]> = {
  quick: BASKET_KEYS.quick.map((entry, index) => ({
    id: `q-${index}-${entry.key}`,
    label: entry.label,
    qty: entry.qty,
    mode: 'quick' as const,
    category: findProduct(entry.key)?.category ?? 'staples',
  })),
  fashion: BASKET_KEYS.fashion.map((entry, index) => ({
    id: `f-${index}-${entry.key}`,
    label: entry.label,
    qty: entry.qty,
    mode: 'fashion' as const,
    category: findProduct(entry.key)?.category ?? 'tshirts',
  })),
};

/**
 * Maps a basket item back onto a catalog entry. The Worker does this with the
 * `matches` table (spec §5); here the seed label order is the match, with a
 * loose name fallback so an item the user types by hand still resolves.
 */
function productForItem(item: BasketItem): SeedProduct | undefined {
  const seeded = BASKET_KEYS[item.mode].find((entry) => entry.label === item.label);
  if (seeded) return findProduct(seeded.key);

  const needle = item.label.toLowerCase();
  return PRODUCTS.find(
    (product) =>
      product.mode === item.mode &&
      (product.name.toLowerCase().includes(needle) ||
        needle.includes(product.name.toLowerCase().split(' ')[0] ?? ' '))
  );
}

function buildComparison(mode: Mode, now: number): BasketComparison {
  const items = basketState[mode];
  const retailers = retailersFor(mode);

  const lines: BasketLine[] = items.map((item) => {
    const product = productForItem(item);
    return { item, offers: product ? offersFor(product, now) : [] };
  });

  const quotes: BasketQuote[] = retailers.map((retailer) => {
    const fees = DEMO_FEES[retailer.id] ?? { deliveryFee: 0, handlingFee: 0 };
    let itemsTotal = 0;
    let inStockCount = 0;
    const missing: string[] = [];
    const ages: number[] = [];

    for (const line of lines) {
      const offer = line.offers.find(
        (candidate) => candidate.retailerId === retailer.id && candidate.inStock
      );
      if (!offer) {
        missing.push(line.item.label);
        continue;
      }
      inStockCount += 1;
      itemsTotal += offer.price * line.item.qty;
      ages.push(offer.capturedAt);
    }

    return {
      retailerId: retailer.id,
      retailerName: retailer.name,
      itemsTotal: Math.round(itemsTotal),
      deliveryFee: fees.deliveryFee,
      handlingFee: fees.handlingFee,
      total: Math.round(itemsTotal + fees.deliveryFee + fees.handlingFee),
      inStockCount,
      itemCount: lines.length,
      missing,
      etaMinutes: DEMO_ETA[retailer.id] ?? null,
      capturedAt: ages.length > 0 ? Math.min(...ages) : capturedAtFor(retailer.id, mode, now),
      fullyStocked: lines.length > 0 && inStockCount === lines.length,
    };
  });

  const ranked = rankQuotes(quotes);
  const stocked = ranked.filter((quote) => quote.fullyStocked);
  const winner = stocked[0] ?? null;
  const runnerUp = stocked[1] ?? null;

  return {
    mode,
    lines,
    quotes: ranked,
    winnerRetailerId: winner?.retailerId ?? null,
    runnerUpRetailerId: runnerUp?.retailerId ?? null,
    savingVsRunnerUp:
      winner && runnerUp ? Math.max(0, runnerUp.total - winner.total) : null,
    capturedAt:
      ranked.length > 0 ? Math.min(...ranked.map((quote) => quote.capturedAt)) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Deals                                                               */
/* ------------------------------------------------------------------ */

function buildDeals(query: DealsQuery, prefs: Prefs, now: number): Deal[] {
  const wanted =
    query.categories && query.categories.length > 0
      ? query.categories
      : prefs.enabledCategories;

  const deals: Deal[] = [];

  for (const product of PRODUCTS) {
    if (product.mode !== query.mode) continue;
    if (wanted.length > 0 && !wanted.includes(product.category)) continue;

    for (const offer of offersFor(product, now)) {
      if (!offer.inStock) continue;
      const discount =
        offer.mrp && offer.mrp > 0 ? (offer.mrp - offer.price) / offer.mrp : null;
      const overThreshold = discount !== null && discount >= prefs.threshold;
      if (!overThreshold && !offer.isPeriodLow) continue;

      deals.push({
        // A period low is the more interesting claim, so it wins the label when
        // an offer qualifies on both counts.
        kind: offer.isPeriodLow ? 'period-low' : 'threshold',
        offer,
        discountPct: discount,
        savedAmount: offer.mrp ? Math.max(0, offer.mrp - offer.price) : null,
      });
    }
  }

  // Deepest discount first; a period low with no MRP still floats above noise.
  deals.sort((a, b) => (b.discountPct ?? 0.35) - (a.discountPct ?? 0.35));
  return typeof query.limit === 'number' ? deals.slice(0, query.limit) : deals;
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export function createFixtureClient(): ApiClient {
  // Seeded so Settings has something to render and Deals has a threshold to
  // filter on, exactly as a returning user's stored prefs would.
  let prefs: Prefs = {
    ...DEFAULT_PREFS,
    threshold: 0.35,
    enabledCategories: [
      'dairy',
      'staples',
      'produce',
      'snacks',
      'beverages',
      'household',
      'tshirts',
      'jeans',
      'footwear',
    ],
    pincode: '560103',
    lat: 12.9279,
    lon: 77.6271,
    fees: { ...DEMO_FEES },
  };

  return {
    baseUrl: 'fixture://bachat',
    demo: true,

    buyUrl(offer) {
      return offer.url;
    },

    health(signal) {
      return settle<HealthReport>(() => {
        const now = Date.now();
        return {
          status: 'degraded',
          lastSweepAt: { quick: sweptAt('quick', now), fashion: sweptAt('fashion', now) },
          // The fashion sweep is 31 h old against a 12 h cadence — the app must
          // be able to say so (spec §9).
          staleSweep: true,
          products: PRODUCTS.reduce((count, product) => count + product.listings.length, 0),
          retailers: retailersFor('quick').length + retailersFor('fashion').length,
          lastPushSentAt: now - 5 * 60 * 60 * 1000,
          retailerHealth: [...retailersFor('quick'), ...retailersFor('fashion')].map(
            (retailer) => {
              const swept = capturedAtFor(retailer.id, retailer.mode, now);
              return {
                id: retailer.id,
                name: retailer.name,
                mode: retailer.mode,
                lastSweepAt: swept,
                ageSeconds: Math.round((now - swept) / 1000),
                stale: retailer.mode === 'fashion',
                productCount: PRODUCTS.filter((p) =>
                  p.listings.some((l) => l.retailerId === retailer.id)
                ).length,
              };
            }
          ),
          serverNow: now,
        };
      }, signal);
    },

    basket(mode, signal) {
      return settle(() => buildComparison(mode, Date.now()), signal);
    },

    saveBasket(mode, items, signal) {
      return settle(() => {
        basketState[mode] = items.map((item: BasketItemInput, index) => ({
          id: item.id ?? `${mode}-${Date.now()}-${index}`,
          label: item.label,
          qty: Math.max(1, Math.round(item.qty)),
          mode,
          category: item.category,
        }));
        return basketState[mode];
      }, signal);
    },

    deals(query, signal) {
      return settle<DealsFeed>(() => {
        const now = Date.now();
        return {
          mode: query.mode,
          deals: buildDeals(query, prefs, now),
          sweptAt: sweptAt(query.mode, now),
          nextCursor: null,
        };
      }, signal);
    },

    compare(query: CompareQuery, signal) {
      return settle<CompareResult>(() => {
        const now = Date.now();
        const needle = query.query.trim().toLowerCase();

        const offers = PRODUCTS.filter((product) => product.mode === query.mode)
          .filter(
            (product) =>
              needle.length === 0 ||
              product.name.toLowerCase().includes(needle) ||
              (product.brand ?? '').toLowerCase().includes(needle) ||
              product.category.includes(needle)
          )
          .filter(
            (product) =>
              !query.brands ||
              query.brands.length === 0 ||
              (product.brand !== null && query.brands.includes(product.brand))
          )
          .filter(
            (product) =>
              !query.sizes ||
              query.sizes.length === 0 ||
              (product.size !== null && query.sizes.includes(product.size))
          )
          .flatMap((product) => offersFor(product, now))
          .filter(
            (offer) => query.maxPrice === undefined || offer.price <= query.maxPrice
          )
          .sort((a, b) => {
            if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
            return a.price - b.price;
          });

        return { mode: query.mode, query: query.query, offers, sweptAt: sweptAt(query.mode, now) };
      }, signal);
    },

    history(productId, signal) {
      return settle<PriceHistory>(() => {
        const [retailerId, key] = productId.split(':');
        const product = key ? findProduct(key) : undefined;
        const listing = product?.listings.find(
          (candidate) => candidate.retailerId === retailerId
        );

        if (!product || !listing) {
          throw new ApiError(
            'server',
            'The price server returned an error (HTTP 404). That product is no longer in the catalog.',
            { status: 404 }
          );
        }

        const days = listing.historyDays ?? 34;
        const points = buildHistory(
          productId,
          listing.price,
          days,
          listing.atPeriodLow ?? false
        );

        const observed = Math.min(30, points.length);
        const low = Math.min(...points.map((point) => point.minPrice));
        const atLow = (listing.atPeriodLow ?? false) && (listing.inStock ?? true);

        return {
          productId,
          points,
          days: observed,
          low,
          high: Math.max(...points.map((point) => point.maxPrice)),
          daysRequested: 30,
          currentPrice: listing.price,
          currentCapturedAt: capturedAtFor(listing.retailerId, product.mode, Date.now()),
          isPeriodLow: atLow,
          periodLowClaim: atLow
            ? `lowest in ${observed} day${observed === 1 ? '' : 's'}`
            : `not a period low (last ${observed} day${observed === 1 ? '' : 's'})`,
        };
      }, signal);
    },

    facets(mode, signal) {
      return settle<Facets>(
        () => ({
          mode,
          retailers: retailersFor(mode),
          categories: categoriesFor(mode),
          brands: mode === 'fashion' ? [...BRANDS] : [],
          sizes: mode === 'fashion' ? [...SIZES] : [],
        }),
        signal
      );
    },

    savePrefs(partial, signal) {
      return settle<Prefs>(() => {
        prefs = { ...prefs, ...partial };
        return prefs;
      }, signal);
    },

    registerDevice(_token, _platform, signal) {
      return settle<void>(() => undefined, signal);
    },
  };
}
