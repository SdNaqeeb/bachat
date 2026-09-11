/**
 * Typed HTTP client for the Bachat Cloudflare Worker.
 *
 * `createClient(baseUrl)` returns an {@link ApiClient}. The same interface is
 * implemented by the fixture client in ./fixture-client.ts, which is what lets
 * screens be built with no Worker running (spec §13) — so nothing in a screen
 * may ever assume it is talking to HTTP.
 *
 * Every failure mode collapses into a single {@link ApiError} whose `message`
 * is finished prose, fit to render straight into an error state. Callers branch
 * on `kind`, never on a status code.
 */

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
  rankQuotes,
} from '@/lib/decode';
import {
  BACKEND_BASE_URL,
  type BasketComparison,
  type BasketItem,
  type BasketItemInput,
  type CompareQuery,
  type CompareResult,
  type DealsFeed,
  type DealsQuery,
  type Facets,
  type HealthReport,
  type Mode,
  type Offer,
  type PriceHistory,
  type Prefs,
  type Retailer,
} from '@/lib/types';

// `ApiError` lives in ./api-error.ts so the decoders can raise it without
// importing this module (which imports them). Re-exported here because every
// screen already imports it from '@/lib/api'.
export { ApiError, type ApiErrorKind } from '@/lib/api-error';
export { rankQuotes };

/**
 * Request budgets. The Worker only reads D1, so everything here is fast; the
 * basket does the most joins and gets the longest leash.
 */
export const TIMEOUTS = {
  health: 6_000,
  basket: 15_000,
  read: 12_000,
  write: 12_000,
} as const;

/**
 * The contract every screen codes against. Two implementations exist:
 * {@link createClient} over HTTP and `createFixtureClient()` over static data.
 *
 * Every method takes an optional `AbortSignal` as its last argument so a screen
 * can cancel on unmount or on a new keystroke.
 */
export type ApiClient = {
  readonly baseUrl: string;
  /** True for the fixture client. Screens use it to show a "demo data" chip. */
  readonly demo: boolean;

  health(signal?: AbortSignal): Promise<HealthReport>;
  /** Regulars priced across every retailer in `mode`, ranked by total. */
  basket(mode: Mode, signal?: AbortSignal): Promise<BasketComparison>;
  /** Replaces the whole basket for a mode. Returns the stored items. */
  saveBasket(
    mode: Mode,
    items: BasketItemInput[],
    signal?: AbortSignal
  ): Promise<BasketItem[]>;
  deals(query: DealsQuery, signal?: AbortSignal): Promise<DealsFeed>;
  compare(query: CompareQuery, signal?: AbortSignal): Promise<CompareResult>;
  history(productId: string, signal?: AbortSignal): Promise<PriceHistory>;
  facets(mode: Mode, signal?: AbortSignal): Promise<Facets>;
  /** Shallow-merges `partial` server-side and returns the full stored prefs. */
  savePrefs(partial: Partial<Prefs>, signal?: AbortSignal): Promise<Prefs>;
  /** Hands the FCM device token to the Worker so the collector can push. */
  registerDevice(
    token: string,
    platform: 'android' | 'ios',
    signal?: AbortSignal
  ): Promise<void>;
  /** Deep link into the retailer's own app/site to buy. Bachat never checks out. */
  buyUrl(offer: Offer): string;
};

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

/** Trailing slashes are a common copy/paste artefact in a configured host. */
export function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** Builds `?a=1&b=x&b=y`, skipping empty values so the URL stays readable. */
export function buildQuery(
  params: Record<string, string | number | boolean | string[] | undefined | null>
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const joined = value.filter((entry) => entry.length > 0);
      if (joined.length === 0) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(joined.join(','))}`);
      continue;
    }
    const asString = String(value);
    if (asString.length === 0) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(asString)}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

type RequestSpec = {
  url: string;
  timeout: number;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** External signal (e.g. component unmount) merged with the timeout. */
  signal?: AbortSignal;
  /** Status codes handed to the caller instead of throwing. */
  passThroughStatuses?: number[];
};

type RawResponse = { status: number; body: unknown };

function networkMessage(baseUrl: string): string {
  return `Couldn't reach Bachat's price server at ${baseUrl}. Check this device's connection — the last prices you saw are still on screen.`;
}

async function request(spec: RequestSpec, baseUrl: string): Promise<RawResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, spec.timeout);

  const onExternalAbort = () => controller.abort();
  spec.signal?.addEventListener('abort', onExternalAbort);

  let response: Response;
  try {
    response = await fetch(spec.url, {
      method: spec.method ?? 'GET',
      headers:
        spec.body === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new ApiError(
        'timeout',
        "The price server didn't respond in time. Pull to refresh in a moment.",
        { cause: error }
      );
    }
    if (spec.signal?.aborted) {
      throw new ApiError('network', 'The request was cancelled.', { cause: error });
    }
    throw new ApiError('network', networkMessage(baseUrl), { cause: error });
  } finally {
    clearTimeout(timer);
    spec.signal?.removeEventListener('abort', onExternalAbort);
  }

  let body: unknown;
  try {
    const text = await response.text();
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (response.ok || spec.passThroughStatuses?.includes(response.status)) {
    return { status: response.status, body };
  }

  if (response.status === 503) {
    throw new ApiError('unavailable', unavailableMessage(body), { status: 503 });
  }

  throw new ApiError(
    'server',
    `The price server returned an error (HTTP ${response.status}). ${
      detailOf(body) ?? 'Try again in a moment.'
    }`,
    { status: response.status }
  );
}

/**
 * Pulls the prose out of the Worker's error envelope,
 * `{ error: { code, message } }`, so a 400's reason reaches the user instead
 * of being swallowed as "[object Object]".
 */
function detailOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const envelope = record.error;
  const nested =
    typeof envelope === 'object' && envelope !== null
      ? (envelope as Record<string, unknown>).message
      : undefined;
  const detail = record.detail ?? record.message ?? nested ?? envelope;
  return typeof detail === 'string' && detail.trim().length > 0
    ? detail.trim()
    : undefined;
}

function unavailableMessage(body: unknown): string {
  const detail = detailOf(body);
  return detail
    ? `Bachat's server is up but has no prices to serve yet: ${detail}`
    : "Bachat's server is up but hasn't finished its first sweep. Prices will appear once one completes.";
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/**
 * Where "buy" goes. In order of preference:
 *
 * 1. `offer.deeplink` — the retailer's own app link, already substituted by
 *    the Worker from `retailers.deeplink_tpl`, whose placeholder is `{ext_id}`.
 *    Only the Worker can fill that in: the app never sees `ext_id`.
 * 2. A caller-supplied `{url}`-style template.
 * 3. The plain product URL.
 */
export function buyUrlFor(offer: Offer, retailer?: Retailer | null): string {
  if (offer.deeplink) return offer.deeplink;
  const template = retailer?.deeplinkTpl;
  if (!template || template.includes('{ext_id}')) return offer.url;
  return template.includes('{url}')
    ? template.replace('{url}', encodeURIComponent(offer.url))
    : `${template}${offer.url}`;
}

export function createClient(rawBaseUrl: string = BACKEND_BASE_URL): ApiClient {
  const baseUrl = normaliseBaseUrl(rawBaseUrl);

  return {
    baseUrl,
    demo: false,

    buyUrl(offer) {
      return buyUrlFor(offer);
    },

    async health(signal) {
      // 503 is a documented, meaningful answer here — read it, don't throw.
      const { status, body } = await request(
        {
          url: `${baseUrl}/api/health`,
          timeout: TIMEOUTS.health,
          signal,
          passThroughStatuses: [503],
        },
        baseUrl
      );

      if (status === 503) {
        throw new ApiError('unavailable', unavailableMessage(body), { status });
      }

      return decodeHealth(body);
    },

    async basket(mode, signal) {
      const { body } = await request(
        {
          url: `${baseUrl}/api/basket${buildQuery({ mode })}`,
          timeout: TIMEOUTS.basket,
          signal,
        },
        baseUrl
      );
      return decodeBasket(body, mode);
    },

    async saveBasket(mode, items, signal) {
      const { body } = await request(
        {
          url: `${baseUrl}/api/basket`,
          method: 'POST',
          timeout: TIMEOUTS.write,
          signal,
          // The Worker's POST is action-based; "replace" is the one action
          // that matches this method's contract of storing the whole list.
          body: encodeBasket(mode, items),
        },
        baseUrl
      );
      return decodeBasketItems(body, mode);
    },

    async deals(query, signal) {
      const { body } = await request(
        {
          url: `${baseUrl}/api/deals${buildQuery({
            mode: query.mode,
            categories: query.categories,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          timeout: TIMEOUTS.read,
          signal,
        },
        baseUrl
      );
      return decodeDeals(body, query.mode);
    },

    async compare(query, signal) {
      const { body } = await request(
        {
          url: `${baseUrl}/api/compare${buildQuery({
            mode: query.mode,
            q: query.query,
            brands: query.brands,
            sizes: query.sizes,
            max_price: query.maxPrice,
          })}`,
          timeout: TIMEOUTS.read,
          signal,
        },
        baseUrl
      );
      return decodeCompare(body, query.mode, query.query);
    },

    async history(productId, signal) {
      const { body } = await request(
        {
          url: `${baseUrl}/api/history/${encodeURIComponent(productId)}`,
          timeout: TIMEOUTS.read,
          signal,
        },
        baseUrl
      );
      return decodeHistory(body, productId);
    },

    async facets(mode, signal) {
      const { body } = await request(
        {
          url: `${baseUrl}/api/facets${buildQuery({ mode })}`,
          timeout: TIMEOUTS.read,
          signal,
        },
        baseUrl
      );
      return decodeFacets(body, mode);
    },

    async savePrefs(partial, signal) {
      const { body } = await request(
        {
          url: `${baseUrl}/api/prefs`,
          method: 'POST',
          timeout: TIMEOUTS.write,
          signal,
          // Domain -> the Worker's flat pref keys (`threshold_pct`,
          // `fees.<retailer>`, ...), which are nothing like the app's names.
          body: encodePrefs(partial),
        },
        baseUrl
      );
      return decodePrefs(body);
    },

    async registerDevice(token, platform, signal) {
      await request(
        {
          url: `${baseUrl}/api/register-device`,
          method: 'POST',
          timeout: TIMEOUTS.write,
          signal,
          body: { token, platform },
        },
        baseUrl
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* Error helpers                                                       */
/* ------------------------------------------------------------------ */

/** True when `error` is an ApiError; useful for exhaustive UI branching. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Best-effort user-facing string for anything thrown anywhere in the app. */
export function messageForError(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Pull to refresh.';
}

/**
 * True when the failure is worth a retry button rather than an explanation.
 * A parse error will fail identically on retry, so it gets no button.
 */
export function isRetryable(error: unknown): boolean {
  return isApiError(error) ? error.kind !== 'parse' : true;
}
