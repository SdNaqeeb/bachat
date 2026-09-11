// GET /api/compare?q=&mode=&brands=&sizes=&max_price= -> one item across retailers

import { Hono } from "hono";
import type { Env, Mode } from "../types";
import { ApiError } from "../types";
import { placeholders } from "../lib/db";

export const compare = new Hono<{ Bindings: Env }>();

const RESULT_LIMIT = 50;

type CompareRow = {
  product_id: string;
  ext_id: string;
  retailer_id: string;
  retailer_name: string;
  deeplink_tpl: string;
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

function buildDeeplink(tpl: string, extId: string): string {
  return tpl.replace("{ext_id}", encodeURIComponent(extId));
}

compare.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) throw new ApiError(400, "bad_request", "q is required");

  const mode = (c.req.query("mode") ?? "quick") as Mode;
  if (mode !== "quick" && mode !== "fashion") {
    throw new ApiError(400, "bad_request", "mode must be 'quick' or 'fashion'");
  }

  const brands = (c.req.query("brands") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const sizes = (c.req.query("sizes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const maxPriceRaw = c.req.query("max_price");
  const maxPrice = maxPriceRaw !== undefined ? Number(maxPriceRaw) : undefined;
  if (maxPriceRaw !== undefined && !Number.isFinite(maxPrice)) {
    throw new ApiError(400, "bad_request", "max_price must be a number");
  }

  const params: unknown[] = [mode, `%${q}%`];
  let clauses = "";
  if (brands.length > 0) {
    clauses += ` AND pr.brand IN (${placeholders(brands.length)})`;
    params.push(...brands);
  }
  if (sizes.length > 0) {
    clauses += ` AND pr.size IN (${placeholders(sizes.length)})`;
    params.push(...sizes);
  }
  if (maxPrice !== undefined) {
    clauses += ` AND lp.price <= ?`;
    params.push(maxPrice);
  }
  params.push(RESULT_LIMIT);

  const { results } = await c.env.DB.prepare(
    `SELECT pr.id AS product_id, pr.ext_id AS ext_id, pr.retailer_id AS retailer_id,
            r.name AS retailer_name, r.deeplink_tpl AS deeplink_tpl,
            pr.name AS name, pr.brand AS brand, pr.size AS size, pr.pack AS pack,
            pr.category AS category, pr.image_url AS image_url, pr.url AS url,
            lp.price AS price, lp.mrp AS mrp, lp.in_stock AS in_stock, lp.captured_at AS captured_at
     FROM products pr
     JOIN retailers r ON r.id = pr.retailer_id
     JOIN prices lp ON lp.product_id = pr.id
       AND lp.captured_at = (SELECT MAX(p2.captured_at) FROM prices p2 WHERE p2.product_id = pr.id)
     WHERE pr.mode = ? AND pr.name LIKE ? ${clauses}
     ORDER BY lp.price ASC
     LIMIT ?`,
  )
    .bind(...params)
    .all<CompareRow>();

  const items = (results ?? []).map((r) => ({
    product_id: r.product_id,
    retailer_id: r.retailer_id,
    retailer_name: r.retailer_name,
    name: r.name,
    brand: r.brand,
    size: r.size,
    pack: r.pack,
    category: r.category,
    image_url: r.image_url,
    mode,
    price: r.price,
    mrp: r.mrp,
    in_stock: r.in_stock === 1,
    captured_at: r.captured_at,
    url: r.url,
    deeplink: buildDeeplink(r.deeplink_tpl, r.ext_id),
  }));

  const sweptAt = items.reduce((max, i) => Math.max(max, i.captured_at), 0);

  return c.json({ query: q, mode, results: items, swept_at: sweptAt > 0 ? sweptAt : null });
});
