/**
 * Malformed-payload handling.
 *
 * Every case here takes a REAL captured Worker response and breaks exactly one
 * field. The decoder must raise a `parse` ApiError — the one error kind the UI
 * deliberately offers no retry button for, because a retry will fail
 * identically — rather than emit a plausible-looking wrong number.
 *
 * The bar is deliberately high on anything that is money or the age of money.
 * A blank screen with an explanation is recoverable; a confident ₹28 that is
 * really ₹280, or a four-hour-old price labelled "just now", is not.
 */

import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api-error';
import {
  decodeBasket,
  decodeCompare,
  decodeDeals,
  decodeFacets,
  decodeHealth,
  decodeHistory,
  decodePrefs,
} from '@/lib/decode';
import { wireCopy } from './wire';

function expectParseFailure(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  expect((thrown as ApiError).kind).toBe('parse');
  // The message is what a user reads in an error state, so it must be prose.
  expect((thrown as ApiError).message).toMatch(/shape this app can't read/);
}

describe('prices', () => {
  it('are rejected when missing, rather than rendered as zero', () => {
    const body = wireCopy('deals-quick');
    delete body.items[0].price;
    expectParseFailure(() => decodeDeals(body, 'quick'));
  });

  it('are rejected when they arrive as a string', () => {
    const body = wireCopy('compare-quick');
    body.results[0].price = '24.00';
    expectParseFailure(() => decodeCompare(body, 'quick', 'Amul'));
  });

  it('are rejected when they arrive as NaN or Infinity', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const body = wireCopy('compare-quick');
      body.results[0].price = bad;
      expectParseFailure(() => decodeCompare(body, 'quick', 'Amul'));
    }
  });

  it('are rejected on a basket line, which is where a wrong total starts', () => {
    const body = wireCopy('basket-quick');
    delete body.retailers[1].lines[0].price;
    expectParseFailure(() => decodeBasket(body, 'quick'));
  });

  it('reject a missing basket subtotal rather than falling back to the item count', () => {
    const body = wireCopy('basket-quick');
    delete body.retailers[1].subtotal;
    expectParseFailure(() => decodeBasket(body, 'quick'));
  });
});

describe('timestamps', () => {
  it('are rejected when they arrive in seconds instead of milliseconds', () => {
    const body = wireCopy('compare-quick');
    // A units regression on the server would otherwise render every price as
    // decades old — or, with a forgiving x1000 rescue, as silently fresh.
    body.results[0].captured_at = Math.floor(body.results[0].captured_at / 1000);
    expectParseFailure(() => decodeCompare(body, 'quick', 'Amul'));
  });

  it('are rejected when missing, so nothing renders without an age (spec §9)', () => {
    const body = wireCopy('deals-quick');
    delete body.items[0].captured_at;
    expectParseFailure(() => decodeDeals(body, 'quick'));
  });

  it('accept a null last-sweep, which honestly means "never swept"', () => {
    const report = decodeHealth(wireCopy('health'));
    expect(report.retailerHealth?.some((r) => r.lastSweepAt === null)).toBe(true);
  });
});

describe('structural drift', () => {
  it('is caught when a list stops being a list', () => {
    const body = wireCopy('facets-quick');
    body.retailers = { blinkit: {} };
    expectParseFailure(() => decodeFacets(body, 'quick'));
  });

  it('is caught when a list disappears entirely', () => {
    const body = wireCopy('compare-quick');
    delete body.results;
    // Silently yielding [] here is how "no results found" lies to the user.
    expectParseFailure(() => decodeCompare(body, 'quick', 'Amul'));
  });

  it('is caught when the basket ranking block goes missing', () => {
    const body = wireCopy('basket-quick');
    delete body.ranking;
    expectParseFailure(() => decodeBasket(body, 'quick'));
  });

  it('is caught when a mode is not a mode', () => {
    const body = wireCopy('deals-quick');
    body.mode = 'groceries';
    expectParseFailure(() => decodeDeals(body, 'quick'));
  });

  it('is caught when a line status is one the app does not know', () => {
    const body = wireCopy('basket-quick');
    body.retailers[0].lines[0].status = 'substituted';
    expectParseFailure(() => decodeBasket(body, 'quick'));
  });

  it('is caught when health counts arrive as the retailer array', () => {
    const body = wireCopy('health');
    body.retailer_count = body.retailers;
    expectParseFailure(() => decodeHealth(body));
  });

  it('is caught when a history series row loses its price', () => {
    const body = wireCopy('history-partial');
    delete body.series[3].min_price;
    expectParseFailure(() => decodeHistory(body, 'blinkit:milk'));
  });
});

describe('settings', () => {
  it('tolerate an unset pref, because never-set is a real server state', () => {
    const body = wireCopy('prefs');
    delete body.prefs.threshold_pct;
    delete body.prefs.quiet_hours;
    delete body.prefs.enabled_categories;
    const prefs = decodePrefs(body);
    expect(prefs.threshold).toBe(0.6);
    expect(prefs.quietHours).toEqual({ start: 23, end: 8 });
    expect(prefs.enabledCategories).toEqual([]);
  });

  it('still reject a pref that is set to something unreadable', () => {
    const malformed = wireCopy('prefs');
    malformed.prefs.threshold_pct = 'sixty percent';
    expectParseFailure(() => decodePrefs(malformed));

    const badHours = wireCopy('prefs');
    badHours.prefs.quiet_hours = { start: '25:00', end: '08:00' };
    expectParseFailure(() => decodePrefs(badHours));

    const badFees = wireCopy('prefs');
    badFees.prefs['fees.blinkit'] = 25;
    expectParseFailure(() => decodePrefs(badFees));
  });
});

describe('a parse failure', () => {
  it('names the field in `cause` for logs but never in `message`', () => {
    const body = wireCopy('deals-quick');
    delete body.items[0].price;
    try {
      decodeDeals(body, 'quick');
      throw new Error('expected a rejection');
    } catch (error) {
      const api = error as ApiError;
      expect(String(api.cause)).toContain('deals.items[0].price');
      expect(api.message).not.toContain('deals.items[0]');
    }
  });
});
