// GET /api/deals?mode=&categories=&limit=&cursor= -> sweep feed, deepest/newest discounts

import { Hono } from "hono";
import type { Env, Mode } from "../types";
import { ApiError } from "../types";
import { daysAgoString } from "../lib/dates";
import { computePeriodLow, type DailyRow } from "../lib/history";
import { placeholders } from "../lib/db";

export const deals = new Hono<{ Bindings: Env }>();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const PERIOD_LOW_WINDOW_DAYS = 30;

type DealRow = {
  product_id: string;
  retailer_id: string;
  retailer_name: string;
  name: string;
  brand: string | null;
  size: string | null;
  pack: string | null;
  category: string | null;
  image_url: string | null;
  url: string | null;
  price: number;
  mrp: number | null;
  in_stock: number;
  captured_at: number;
};

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const n = parseInt(atob(cursor), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(offset: number): string {
  return btoa(String(offset));
}

deals.get("/", async (c) => {
  const mode = (c.req.query("mode") ?? "quick") as Mode;
  if (mode !== "quick" && mode !== "fashion") {
    throw new ApiError(400, "bad_request", "mode must be 'quick' or 'fashion'");
  }
  const categories = (c.req.query("categories") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(c.req.query("limit") ?? "", 10) || DEFAULT_LIMIT));
  const offset = decodeCursor(c.req.query("cursor"));

  const params: unknown[] = [mode];
  let categoryClause = "";
  if (categories.length > 0) {
    categoryClause = `AND pr.category IN (${placeholders(categories.length)})`;
    params.push(...categories);
  }
  params.push(limit + 1, offset);

  const { results } = await c.env.DB.prepare(
    `SELECT pr.id AS product_id, pr.retailer_id AS retailer_id, r.name AS retailer_name,
            pr.name AS name, pr.brand AS brand, pr.size AS size, pr.pack AS pack,
            pr.category AS category, pr.image_url AS image_url, pr.url AS url,
            lp.price AS price, lp.mrp AS mrp, lp.in_stock AS in_stock, lp.captured_at AS captured_at
     FROM products pr
     JOIN retailers r ON r.id = pr.retailer_id
     JOIN prices lp ON lp.product_id = pr.id
       AND lp.captured_at = (SELECT MAX(p2.captured_at) FROM prices p2 WHERE p2.product_id = pr.id)
     WHERE pr.mode = ? ${categoryClause}
     ORDER BY
       (CASE WHEN lp.mrp IS NOT NULL AND lp.mrp > 0
             THEN (lp.mrp - lp.price) / lp.mrp ELSE 0 END) DESC,
       lp.captured_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...params)
    .all<DealRow>();

  const rows = results ?? [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  // Batch-fetch price_daily for the honesty-rule claim, one query for the
  // whole page rather than one per item.
  const windowStart = daysAgoString(PERIOD_LOW_WINDOW_DAYS);
  const dailyByProduct = new Map<string, DailyRow[]>();
  if (page.length > 0) {
    const ids = page.map((r) => r.product_id);
    const { results: dailyRows } = await c.env.DB.prepare(
      `SELECT product_id, day, min_price, max_price FROM price_daily
       WHERE product_id IN (${placeholders(ids.length)}) AND day >= ?
       ORDER BY product_id, day DESC`,
    )
      .bind(...ids, windowStart)
      .all<{ product_id: string; day: string; min_price: number; max_price: number }>();
    for (const row of dailyRows ?? []) {
      const list = dailyByProduct.get(row.product_id) ?? [];
      list.push(row);
      dailyByProduct.set(row.product_id, list);
    }
  }

  const items = page.map((r) => {
    const mrp = r.mrp;
    const discountPct = mrp && mrp > 0 ? Math.max(0, (mrp - r.price) / mrp) : 0;
    const daily = dailyByProduct.get(r.product_id) ?? [];
    return {
      product_id: r.product_id,
      retailer_id: r.retailer_id,
      retailer_name: r.retailer_name,
      name: r.name,
      brand: r.brand,
      size: r.size,
      pack: r.pack,
      mode,
      category: r.category,
      image_url: r.image_url,
      url: r.url,
      price: r.price,
      mrp: r.mrp,
      discount_pct: Math.round(discountPct * 1000) / 1000,
      in_stock: r.in_stock === 1,
      captured_at: r.captured_at,
      period_low: computePeriodLow(daily, r.price, PERIOD_LOW_WINDOW_DAYS),
    };
  });

  // `swept_at` is the newest observation on this page — the honest answer to
  // "how old are these prices?" without the app having to re-derive it.
  const sweptAt = items.reduce((max, i) => Math.max(max, i.captured_at), 0);

  return c.json({
    mode,
    items,
    swept_at: sweptAt > 0 ? sweptAt : null,
    next_cursor: hasMore ? encodeCursor(offset + limit) : null,
  });
});
