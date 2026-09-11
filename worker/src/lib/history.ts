// The 30-day-low honesty rule (spec section 7).
//
// The app is only ever allowed to claim what history actually backs. If the
// product has fewer than `windowDays` (default 30) of price_daily rows, the
// claim must say the REAL number of days observed ("lowest in 12 days"), and
// must never say "30-day low" when only 12 days exist.
//
// This module is pure (no D1 access) so it is trivially unit-testable.

import type { PeriodLowClaim } from "../types";

export type DailyRow = { day: string; min_price: number; max_price: number };

/**
 * Given the rollup rows for a product within the requested window (already
 * filtered to the window by the caller's SQL), decide whether `currentPrice`
 * is a period low and build the honest claim string.
 *
 * days_observed = number of distinct days of history actually available,
 * which may be less than the requested window. The claim always uses this
 * real number, never the requested window size.
 */
export function computePeriodLow(
  dailyRows: DailyRow[],
  currentPrice: number,
  windowDays: number,
): PeriodLowClaim {
  const daysObserved = dailyRows.length;

  if (daysObserved === 0) {
    return {
      is_period_low: false,
      days_observed: 0,
      low_price: currentPrice,
      claim: "no price history yet",
    };
  }

  const lowPrice = Math.min(...dailyRows.map((r) => r.min_price));
  const isPeriodLow = currentPrice <= lowPrice;

  // Never claim the full requested window unless we actually have that many
  // distinct days of data. The label always reflects days_observed, which is
  // capped at windowDays by the caller's query, so this can never overstate.
  const claimDays = Math.min(daysObserved, windowDays);
  const claim = isPeriodLow
    ? `lowest in ${claimDays} day${claimDays === 1 ? "" : "s"}`
    : `not a period low (last ${claimDays} day${claimDays === 1 ? "" : "s"})`;

  return {
    is_period_low: isPeriodLow,
    days_observed: daysObserved,
    low_price: lowPrice,
    claim,
  };
}

/** The per-product history payload shared by GET /api/history/:productId and
 * POST /api/history/bulk. Both routes build their response through this
 * function, so there is exactly ONE implementation of the honesty rule on the
 * server: `days_observed` is always the real row count, never the requested
 * window, never a padded series, never a default. */
export type ProductHistory = {
  product_id: string;
  days_observed: number;
  series: DailyRow[];
  current_price: number | null;
  current_captured_at: number | null;
  period_low: PeriodLowClaim | null;
};

export function buildProductHistory(
  productId: string,
  series: DailyRow[],
  latest: { price: number; captured_at: number } | null,
  windowDays: number,
): ProductHistory {
  // Fall back to the newest rollup row only when there is no raw price at
  // all. If there is neither, current_price stays null and no period-low
  // claim is made — an absent claim is honest, an invented one is not.
  const currentPrice =
    latest?.price ?? (series.length > 0 ? (series[series.length - 1] as DailyRow).min_price : null);

  return {
    product_id: productId,
    days_observed: series.length,
    series,
    current_price: currentPrice,
    current_captured_at: latest?.captured_at ?? null,
    period_low: currentPrice == null ? null : computePeriodLow(series, currentPrice, windowDays),
  };
}
