/**
 * The honesty rule (spec §7), on the app side of the wire.
 *
 * "Until 30 days of data exist for a product, the alert and the UI say
 * 'lowest in N days' with the real N. It must never claim a 30-day low it
 * cannot substantiate. This is stated explicitly because it is the single
 * easiest thing for an implementer to get wrong."
 *
 * The Worker gets this right (`worker/src/lib/history.ts`, tested there). The
 * risk this file covers is the mapping: a decoder that defaults a missing
 * `days_observed` to 30, or to `days_requested`, turns an honest server into a
 * lying app. Every case below is about the app REFUSING to fill that blank.
 */

import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api-error';
import { decodeDeals, decodeHistory, decodePeriodLow } from '@/lib/decode';
import { wireCopy } from './wire';

function apiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('expected the decoder to reject this payload, but it accepted it');
}

describe('the real N survives the mapping', () => {
  it('carries 12 days as 12, next to a server that asked for 30', () => {
    const history = decodeHistory(wireCopy('history-partial'), 'blinkit:milk');
    expect(history.days).toBe(12);
    expect(history.daysRequested).toBe(30);
    expect(history.periodLowClaim).toBe('lowest in 12 days');
    expect(history.periodLowClaim).not.toContain('30');
  });

  it('never substitutes days_requested for days_observed', () => {
    const body = wireCopy('history-partial');
    delete body.days_observed;
    // `days_requested: 30` is still sitting right there in the payload. Using
    // it would produce a confident, unearned "30-day low".
    const error = apiError(() => decodeHistory(body, 'blinkit:milk'));
    expect(error.kind).toBe('parse');
    expect(String(error.cause)).toContain('days_observed');
  });

  it('rejects a days_observed that disagrees with the series it came with', () => {
    const body = wireCopy('history-partial');
    body.days_observed = 30;
    const error = apiError(() => decodeHistory(body, 'blinkit:milk'));
    expect(error.kind).toBe('parse');
    expect(String(error.cause)).toContain('series holds 12');
  });

  it('rejects a days_observed that is not a whole count of days', () => {
    for (const bad of [12.5, -1, '12', null, NaN]) {
      const body = wireCopy('history-partial');
      body.days_observed = bad;
      expect(() => decodeHistory(body, 'blinkit:milk')).toThrow(ApiError);
    }
  });

  it('rejects a period_low whose day count contradicts the top-level one', () => {
    const body = wireCopy('history-partial');
    body.period_low.days_observed = 30;
    body.period_low.claim = 'lowest in 30 days';
    const error = apiError(() => decodeHistory(body, 'blinkit:milk'));
    expect(String(error.cause)).toContain('disagrees');
  });
});

describe('no history at all', () => {
  it('is reported as zero days and no claim, never as a low', () => {
    const history = decodeHistory(wireCopy('history-empty'), 'blinkit:bread');
    expect(history.days).toBe(0);
    expect(history.points).toEqual([]);
    expect(history.isPeriodLow).toBe(false);
    // The server's own honest wording, carried through verbatim.
    expect(history.periodLowClaim).toBe('no price history yet');
  });

  it('yields "unknown", not "not a low", on a route that carries no history', () => {
    // A route with no `period_low` at all (compare, basket lines) must be
    // distinguishable from one that looked and found nothing: null claim.
    const unknown = decodePeriodLow(undefined, 'price data', 'x');
    expect(unknown).toEqual({
      periodLow: null,
      historyDays: 0,
      isPeriodLow: false,
      claim: null,
    });
  });

  it('refuses a server that claims a low over zero days', () => {
    const error = apiError(() =>
      decodePeriodLow(
        { is_period_low: true, days_observed: 0, low_price: 45, claim: 'lowest ever' },
        'price data',
        'x'
      )
    );
    expect(error.kind).toBe('parse');
    expect(String(error.cause)).toContain('days_observed = 0');
  });

  it('refuses a period_low with no days_observed at all', () => {
    const error = apiError(() =>
      decodePeriodLow({ is_period_low: true, low_price: 28, claim: 'lowest ever' }, 'x', 'x')
    );
    expect(error.kind).toBe('parse');
  });
});

describe('the deals feed', () => {
  it("carries each item's real N rather than one N for the page", () => {
    const feed = decodeDeals(wireCopy('deals-quick'), 'quick');
    const byProduct = Object.fromEntries(
      feed.deals.map((d) => [d.offer.productId, d.offer])
    );
    expect(byProduct['blinkit:milk']?.historyDays).toBe(12);
    expect(byProduct['bigbasket:milk']?.historyDays).toBe(30);
    expect(byProduct['blinkit:bread']?.historyDays).toBe(0);
    expect(byProduct['blinkit:bread']?.periodLowClaim).toBe('no price history yet');
  });

  it('refuses the whole page when one item has lost its day count', () => {
    const body = wireCopy('deals-quick');
    const target = body.items.find((i: any) => i.product_id === 'blinkit:milk');
    delete target.period_low.days_observed;
    // One unverifiable claim is not worth a screenful of trustworthy ones:
    // the page fails loudly instead of rendering that item's badge blank.
    expect(() => decodeDeals(body, 'quick')).toThrow(ApiError);
  });

  it('does not promote an item to period-low on its discount alone', () => {
    const body = wireCopy('deals-quick');
    const target = body.items.find((i: any) => i.product_id === 'blinkit:bread');
    target.discount_pct = 0.9;
    const feed = decodeDeals(body, 'quick');
    const bread = feed.deals.find((d) => d.offer.productId === 'blinkit:bread');
    expect(bread?.kind).toBe('threshold');
    expect(bread?.offer.isPeriodLow).toBe(false);
  });
});
