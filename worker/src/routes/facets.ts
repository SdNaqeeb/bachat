// GET /api/facets?mode=fashion&category= -> everything the filter UI needs for
// one mode in one round trip: retailers, categories, brands and sizes.
//
// `retailers` and `categories` live here (rather than on a route of their own)
// because the app's filter pickers need all four lists together and a second
// request would just double the latency of opening a filter sheet.

import { Hono } from "hono";
import type { Env, Mode } from "../types";
import { ApiError } from "../types";

export const facets = new Hono<{ Bindings: Env }>();

facets.get("/", async (c) => {
  const mode = (c.req.query("mode") ?? "quick") as Mode;
  if (mode !== "quick" && mode !== "fashion") {
    throw new ApiError(400, "bad_request", "mode must be 'quick' or 'fashion'");
  }
  const category = c.req.query("category");

  const categoryClause = category ? "AND category = ?" : "";
  const params = category ? [mode, category] : [mode];

  const [brandsRes, sizesRes, retailersRes, categoriesRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT DISTINCT brand FROM products WHERE mode = ? ${categoryClause} AND brand IS NOT NULL ORDER BY brand`,
    )
      .bind(...params)
      .all<{ brand: string }>(),
    c.env.DB.prepare(
      `SELECT DISTINCT size FROM products WHERE mode = ? ${categoryClause} AND size IS NOT NULL ORDER BY size`,
    )
      .bind(...params)
      .all<{ size: string }>(),
    c.env.DB.prepare(
      "SELECT id, name, mode, deeplink_tpl FROM retailers WHERE mode = ? ORDER BY id",
    )
      .bind(mode)
      .all<{ id: string; name: string; mode: Mode; deeplink_tpl: string }>(),
    // Categories are whatever the catalog actually holds for this mode — the
    // app must never offer a filter that can only ever return nothing.
    c.env.DB.prepare(
      `SELECT category, COUNT(*) AS product_count FROM products
       WHERE mode = ? AND category IS NOT NULL
       GROUP BY category ORDER BY category`,
    )
      .bind(mode)
      .all<{ category: string; product_count: number }>(),
  ]);

  return c.json({
    mode,
    category: category ?? null,
    retailers: retailersRes.results ?? [],
    categories: (categoriesRes.results ?? []).map((r) => ({
      id: r.category,
      mode,
      product_count: r.product_count,
    })),
    brands: (brandsRes.results ?? []).map((r) => r.brand),
    sizes: (sizesRes.results ?? []).map((r) => r.size),
  });
});
