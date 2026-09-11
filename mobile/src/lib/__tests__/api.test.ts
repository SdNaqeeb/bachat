/**
 * The HTTP client wired to the decoders, with `fetch` stubbed to return the
 * real captured Worker bodies.
 *
 * The decoder tests prove the mapping is right; this proves `createClient` is
 * actually using it — the right URL, the right query parameters, the right
 * request body, and the decoded result rather than the raw JSON.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, buyUrlFor, createClient } from '@/lib/api';
import { wire } from './wire';

const BASE = 'https://worker.invalid';

type Call = { url: string; init: RequestInit };

/** Replies to every request with `body`, recording what was asked for. */
function stubFetch(body: unknown, status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createClient', () => {
  it('decodes /api/health into the app report', async () => {
    const calls = stubFetch(wire('health'));
    const report = await createClient(BASE).health();
    expect(calls[0]?.url).toBe(`${BASE}/api/health`);
    expect(report.retailers).toBe(6);
    expect(report.status).toBe('degraded');
  });

  it('trims a trailing slash off the configured host', async () => {
    const calls = stubFetch(wire('facets-quick'));
    await createClient(`${BASE}/`).facets('quick');
    expect(calls[0]?.url).toBe(`${BASE}/api/facets?mode=quick`);
  });

  it('pivots the basket body into per-item lines', async () => {
    stubFetch(wire('basket-quick'));
    const basket = await createClient(BASE).basket('quick');
    expect(basket.lines).toHaveLength(2);
    expect(basket.winnerRetailerId).toBe('blinkit');
  });

  it('POSTs the replace action the Worker implements', async () => {
    const calls = stubFetch(wire('basket-replace'));
    const items = await createClient(BASE).saveBasket('quick', [
      { id: 'i-milk', label: 'Amul Taaza 500 ml', qty: 3, mode: 'quick', category: 'dairy' },
    ]);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      action: 'replace',
      mode: 'quick',
    });
    expect(items[0]?.qty).toBe(3);
  });

  it('sends compare filters under the Worker parameter names', async () => {
    const calls = stubFetch(wire('compare-fashion'));
    const result = await createClient(BASE).compare({
      mode: 'fashion',
      query: 'Tee',
      brands: ['Nike', 'Levis'],
      sizes: ['M'],
      maxPrice: 2000,
    });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/compare?mode=fashion&q=Tee&brands=Nike%2CLevis&sizes=M&max_price=2000`
    );
    expect(result.offers).toHaveLength(2);
  });

  it('translates settings into the Worker pref keys', async () => {
    const calls = stubFetch(wire('prefs'));
    const prefs = await createClient(BASE).savePrefs({ threshold: 0.45 });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ threshold_pct: 0.45 });
    expect(prefs.fees.blinkit).toEqual({ deliveryFee: 20, handlingFee: 5 });
  });

  it('surfaces the Worker error envelope as prose, not as [object Object]', async () => {
    stubFetch(wire('error-404'), 404);
    await expect(createClient(BASE).history('nope')).rejects.toThrow(/product not found/);
  });

  it('raises a parse error, not a wrong number, on a drifted payload', async () => {
    stubFetch({ retailers: [], modes: {}, status: 'ok' });
    const error = await createClient(BASE).health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('parse');
  });
});

describe('buyUrlFor', () => {
  it('prefers the deep link the Worker already substituted', async () => {
    stubFetch(wire('basket-quick'));
    const basket = await createClient(BASE).basket('quick');
    const offer = basket.lines[0]?.offers.find((o) => o.retailerId === 'blinkit');
    expect(offer && buyUrlFor(offer)).toBe('blinkit://product/milk?utm_source=bachat');
  });

  it('never hands back a template with an unfilled {ext_id} placeholder', async () => {
    stubFetch(wire('compare-quick'));
    const result = await createClient(BASE).compare({ mode: 'quick', query: 'Amul' });
    const offer = result.offers[0];
    // /api/compare carries a `deeplink` of its own; a retailer template whose
    // placeholder only the server can fill must never leak into a URL.
    const url = offer ? buyUrlFor(offer, {
      id: 'blinkit',
      name: 'Blinkit',
      mode: 'quick',
      deeplinkTpl: 'blinkit://product/{ext_id}',
      initials: 'BL',
      tint: '#F8CB46',
    }) : '';
    expect(url).not.toContain('{ext_id}');
  });
});
