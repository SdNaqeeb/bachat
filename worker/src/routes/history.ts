// GET /api/history/:productId?days=30 -> price series for the sparkline,
// carrying the honest days_observed count (spec section 7).

import { Hono } from "hono";
import type { Env } from "../types";
import { ApiError } from "../types";
import { daysAgoString } from "../lib/dates";
import { computePeriodLow, type DailyRow } from "../lib/history";

export const history = new Hono<{ Bindings: Env }>();

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90; // matches the prices retention window (spec section 5)

history.get("/:productId", async (c) => {
  const productId = c.req.param("productId");
  const daysRequested = Math.min(
    MAX_DAYS,
    Math.max(1, parseInt(c.req.query("days") ?? "", 10) || DEFAULT_DAYS),
  );

  const product = await c.env.DB.prepare("SELECT id FROM products WHERE id = ?")
    .bind(productId)
    .first<{ id: string }>();
  if (!product) throw new ApiError(404, "not_found", "product not found");

  const windowStart = daysAgoString(daysRequested);
  const { results } = await c.env.DB.prepare(
    `SELECT day, min_price, max_price FROM price_daily
     WHERE product_id = ? AND day >= ?
     ORDER BY day ASC`,
  )
    .bind(productId, windowStart)
    .all<DailyRow>();

  const series = results ?? [];

  const latest = await c.env.DB.prepare(
    "SELECT price, captured_at FROM prices WHERE product_id = ? ORDER BY captured_at DESC LIMIT 1",
  )
    .bind(productId)
    .first<{ price: number; captured_at: number }>();

  const currentPrice = latest?.price ?? (series.length > 0 ? (series[series.length - 1] as DailyRow).min_price : null);

  const periodLow = currentPrice == null ? null : computePeriodLow(series, currentPrice, daysRequested);

  return c.json({
    product_id: productId,
    days_requested: daysRequested,
    days_observed: series.length,
    series,
    current_price: currentPrice,
    current_captured_at: latest?.captured_at ?? null,
    period_low: periodLow,
  });
});
