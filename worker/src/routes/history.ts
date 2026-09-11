// GET  /api/history/:productId?days=30 -> price series for the sparkline,
//      carrying the honest days_observed count (spec section 7).
// POST /api/history/bulk               -> the same thing for many products in
//      ONE round trip, which is what keeps a ~400-product sweep inside the
//      ~6 minute budget of spec section 12.
//
// Both responses are built by the same `buildProductHistory` helper, so the
// honesty rule has exactly one implementation: days_observed is the real
// number of price_daily rows in the window. It is never defaulted to 30,
// never padded, and a product with no history reports 0 with no period-low
// claim at all.

import { Hono } from "hono";
import type { Env } from "../types";
import { ApiError } from "../types";
import { daysAgoString } from "../lib/dates";
import { buildProductHistory, type DailyRow, type ProductHistory } from "../lib/history";
import { chunk, placeholders } from "../lib/db";

export const history = new Hono<{ Bindings: Env }>();

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90; // matches the prices retention window (spec section 5)

/** Ids per request. A quick sweep is ~400 products per retailer, so this is
 * one or two requests per retailer instead of 400. */
const MAX_BULK_IDS = 500;

/** Ids per SQL statement. D1 caps a prepared statement at 100 bound
 * parameters, and every query below binds one extra parameter for the window
 * start, so 90 leaves headroom and still means only ceil(400/90) = 5 chunks —
 * 15 set-based queries for a whole retailer, never a query per product. Each
 * chunk is 3 queries over an indexed IN list, which stays far inside the
 * Worker's 10 ms CPU budget (spec section 2). */
const SQL_CHUNK = 90;

function clampDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  return Math.min(MAX_DAYS, Math.max(1, Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAYS));
}

history.get("/:productId", async (c) => {
  const productId = c.req.param("productId");
  const daysRequested = clampDays(c.req.query("days"));

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

  // Spelled out rather than spread so the key order (and therefore the wire
  // fixture the app's decoder tests read) is unchanged by this refactor.
  const h = buildProductHistory(productId, series, latest ?? null, daysRequested);
  return c.json({
    product_id: h.product_id,
    days_requested: daysRequested,
    days_observed: h.days_observed,
    series: h.series,
    current_price: h.current_price,
    current_captured_at: h.current_captured_at,
    period_low: h.period_low,
  });
});

type BulkBody = { product_ids?: unknown; days?: unknown };

history.post("/bulk", async (c) => {
  const body = await c.req.json<BulkBody>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "bad_request", "body must be an object");
  }
  if (!Array.isArray(body.product_ids)) {
    throw new ApiError(400, "bad_request", "product_ids must be an array of product ids");
  }
  const ids = Array.from(
    new Set(body.product_ids.filter((v): v is string => typeof v === "string" && v.length > 0)),
  );
  if (ids.length > MAX_BULK_IDS) {
    throw new ApiError(400, "bad_request", `at most ${MAX_BULK_IDS} product_ids per request`);
  }

  const daysRequested = clampDays(body.days);
  const windowStart = daysAgoString(daysRequested);

  const known = new Set<string>();
  const dailyByProduct = new Map<string, DailyRow[]>();
  const latestByProduct = new Map<string, { price: number; captured_at: number }>();

  // Three SET-BASED queries per chunk. Never one query per product: that is
  // the whole point of this route.
  for (const part of chunk(ids, SQL_CHUNK)) {
    const marks = placeholders(part.length);

    const [existing, daily, latest] = await Promise.all([
      c.env.DB.prepare(`SELECT id FROM products WHERE id IN (${marks})`)
        .bind(...part)
        .all<{ id: string }>(),
      c.env.DB.prepare(
        `SELECT product_id, day, min_price, max_price FROM price_daily
         WHERE product_id IN (${marks}) AND day >= ?
         ORDER BY product_id ASC, day ASC`,
      )
        .bind(...part, windowStart)
        .all<{ product_id: string } & DailyRow>(),
      c.env.DB.prepare(
        `SELECT p.product_id AS product_id, p.price AS price, p.captured_at AS captured_at
         FROM prices p
         WHERE p.product_id IN (${marks})
           AND p.captured_at = (SELECT MAX(p2.captured_at) FROM prices p2
                                WHERE p2.product_id = p.product_id)`,
      )
        .bind(...part)
        .all<{ product_id: string; price: number; captured_at: number }>(),
    ]);

    for (const row of existing.results ?? []) known.add(row.id);
    for (const row of daily.results ?? []) {
      const list = dailyByProduct.get(row.product_id) ?? [];
      list.push({ day: row.day, min_price: row.min_price, max_price: row.max_price });
      dailyByProduct.set(row.product_id, list);
    }
    for (const row of latest.results ?? []) {
      latestByProduct.set(row.product_id, { price: row.price, captured_at: row.captured_at });
    }
  }

  // A product id we have never seen is reported as missing, not as a product
  // with zero history — those are different facts and the caller must be able
  // to tell them apart.
  const missing = ids.filter((id) => !known.has(id));
  const items: ProductHistory[] = ids
    .filter((id) => known.has(id))
    .map((id) =>
      buildProductHistory(
        id,
        dailyByProduct.get(id) ?? [],
        latestByProduct.get(id) ?? null,
        daysRequested,
      ),
    );

  return c.json({
    days_requested: daysRequested,
    requested: ids.length,
    items,
    missing,
  });
});
