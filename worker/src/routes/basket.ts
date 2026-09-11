// GET  /api/basket?mode=quick   -> basket priced per retailer + ranking
// POST /api/basket               -> add/remove/update a basket item

import { Hono } from "hono";
import type { Env, Mode } from "../types";
import { ApiError } from "../types";
import { getRetailers } from "../lib/db";
import {
  rankBasket,
  type BasketItemInput,
  type RetailerBasketInput,
  type RetailerLineInput,
} from "../lib/basket";

export const basket = new Hono<{ Bindings: Env }>();

type MatchRow = {
  basket_item_id: string;
  retailer_id: string;
  product_id: string;
  ext_id: string;
  deeplink_tpl: string;
  name: string;
  brand: string | null;
  size: string | null;
  pack: string | null;
  image_url: string | null;
  url: string | null;
  category: string | null;
  mode: string;
  price: number;
  mrp: number | null;
  in_stock: number;
  captured_at: number;
};

function buildDeeplink(tpl: string, extId: string): string {
  return tpl.replace("{ext_id}", encodeURIComponent(extId));
}

async function loadFeesByRetailer(env: Env): Promise<
  Map<string, { delivery: number; handling: number; eta_minutes: number | null }>
> {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM prefs WHERE key LIKE 'fees.%'",
  ).all<{ key: string; value: string }>();
  const map = new Map<string, { delivery: number; handling: number; eta_minutes: number | null }>();
  for (const row of results ?? []) {
    const retailerId = row.key.slice("fees.".length);
    try {
      map.set(retailerId, JSON.parse(row.value));
    } catch {
      // ignore malformed pref
    }
  }
  return map;
}

basket.get("/", async (c) => {
  const mode = (c.req.query("mode") ?? "quick") as Mode;
  if (mode !== "quick" && mode !== "fashion") {
    throw new ApiError(400, "bad_request", "mode must be 'quick' or 'fashion'");
  }

  const { results: itemRows } = await c.env.DB.prepare(
    "SELECT id AS basket_item_id, label, qty, category FROM basket_items WHERE mode = ? ORDER BY label",
  )
    .bind(mode)
    .all<{ basket_item_id: string; label: string; qty: number; category: string | null }>();

  const items: BasketItemInput[] = (itemRows ?? []).map((r) => ({
    basket_item_id: r.basket_item_id,
    label: r.label,
    qty: r.qty,
  }));

  const allRetailers = (await getRetailers(c.env)).filter((r) => r.mode === mode);

  if (items.length === 0 || allRetailers.length === 0) {
    return c.json({
      mode,
      items: itemRows ?? [],
      retailers: [],
      ranking: { winner: null, runner_up: null, winner_saving: null, eligible_for_win: [] },
    });
  }

  const { results: matchRows } = await c.env.DB.prepare(
    `SELECT m.basket_item_id AS basket_item_id, pr.retailer_id AS retailer_id,
            pr.id AS product_id, pr.ext_id AS ext_id, r.deeplink_tpl AS deeplink_tpl,
            pr.name AS name, pr.brand AS brand, pr.size AS size, pr.pack AS pack,
            pr.image_url AS image_url, pr.url AS url, pr.category AS category, pr.mode AS mode,
            lp.price AS price, lp.mrp AS mrp, lp.in_stock AS in_stock, lp.captured_at AS captured_at
     FROM matches m
     JOIN basket_items bi ON bi.id = m.basket_item_id
     JOIN products pr ON pr.id = m.product_id
     JOIN retailers r ON r.id = pr.retailer_id
     JOIN prices lp ON lp.product_id = pr.id
       AND lp.captured_at = (SELECT MAX(p2.captured_at) FROM prices p2 WHERE p2.product_id = pr.id)
     WHERE bi.mode = ?`,
  )
    .bind(mode)
    .all<MatchRow>();

  const feesByRetailer = await loadFeesByRetailer(c.env);

  const linesByRetailer = new Map<string, RetailerLineInput[]>();
  for (const row of matchRows ?? []) {
    const line: RetailerLineInput = {
      basket_item_id: row.basket_item_id,
      product_id: row.product_id,
      retailer_id: row.retailer_id,
      name: row.name,
      brand: row.brand,
      size: row.size,
      pack: row.pack,
      image_url: row.image_url,
      url: row.url,
      category: row.category,
      mode: row.mode,
      deeplink: buildDeeplink(row.deeplink_tpl, row.ext_id),
      price: row.price,
      mrp: row.mrp,
      in_stock: row.in_stock === 1,
      captured_at: row.captured_at,
    };
    const list = linesByRetailer.get(row.retailer_id) ?? [];
    list.push(line);
    linesByRetailer.set(row.retailer_id, list);
  }

  const retailerInputs: RetailerBasketInput[] = allRetailers.map((r) => ({
    retailer_id: r.id,
    retailer_name: r.name,
    fees: feesByRetailer.get(r.id) ?? { delivery: 0, handling: 0, eta_minutes: null },
    lines: linesByRetailer.get(r.id) ?? [],
  }));

  const result = rankBasket(items, retailerInputs);

  return c.json({ mode, items: itemRows ?? [], ...result });
});

type BasketPostBody = {
  action: "add" | "remove" | "update" | "replace";
  basket_item_id?: string;
  label?: string;
  qty?: number;
  mode?: Mode;
  category?: string | null;
  /** `replace` only: the complete desired basket for `mode`. */
  items?: { basket_item_id?: string; id?: string; label?: string; qty?: number; category?: string | null }[];
};

basket.post("/", async (c) => {
  const body = await c.req.json<BasketPostBody>().catch(() => null);
  if (!body || typeof body.action !== "string") {
    throw new ApiError(400, "bad_request", "action is required ('add' | 'remove' | 'update')");
  }

  if (body.action === "add") {
    if (!body.label || !body.mode) {
      throw new ApiError(400, "bad_request", "label and mode are required to add a basket item");
    }
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO basket_items (id, label, qty, mode, category) VALUES (?,?,?,?,?)",
    )
      .bind(id, body.label, body.qty ?? 1, body.mode, body.category ?? null)
      .run();
    return c.json({
      ok: true,
      item: { basket_item_id: id, label: body.label, qty: body.qty ?? 1, mode: body.mode, category: body.category ?? null },
    });
  }

  // `replace` sets the WHOLE basket for a mode in one round trip. The app
  // edits a basket as a list, not as a stream of add/remove deltas, and doing
  // it item-by-item over HTTP would leave the basket half-written whenever a
  // request in the middle of the sequence failed.
  if (body.action === "replace") {
    if (!body.mode || (body.mode !== "quick" && body.mode !== "fashion")) {
      throw new ApiError(400, "bad_request", "mode is required to replace a basket");
    }
    const incoming = Array.isArray(body.items) ? body.items : null;
    if (!incoming) {
      throw new ApiError(400, "bad_request", "items must be an array to replace a basket");
    }
    const mode = body.mode;
    const items = incoming.map((raw, index) => {
      if (typeof raw?.label !== "string" || raw.label.trim().length === 0) {
        throw new ApiError(400, "bad_request", `items[${index}].label is required`);
      }
      const qty = raw.qty === undefined ? 1 : Number(raw.qty);
      if (!Number.isFinite(qty) || qty < 1) {
        throw new ApiError(400, "bad_request", `items[${index}].qty must be a positive number`);
      }
      return {
        basket_item_id: raw.basket_item_id ?? raw.id ?? crypto.randomUUID(),
        label: raw.label.trim(),
        qty: Math.round(qty),
        mode,
        category: raw.category ?? null,
      };
    });

    const keep = new Set(items.map((i) => i.basket_item_id));
    const { results: existing } = await c.env.DB.prepare(
      "SELECT id FROM basket_items WHERE mode = ?",
    )
      .bind(mode)
      .all<{ id: string }>();
    const doomed = (existing ?? []).map((r) => r.id).filter((id) => !keep.has(id));

    const statements = [
      ...doomed.flatMap((id) => [
        c.env.DB.prepare("DELETE FROM matches WHERE basket_item_id = ?").bind(id),
        c.env.DB.prepare("DELETE FROM basket_items WHERE id = ?").bind(id),
      ]),
      ...items.map((i) =>
        c.env.DB.prepare(
          `INSERT INTO basket_items (id, label, qty, mode, category) VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET label = excluded.label, qty = excluded.qty,
             mode = excluded.mode, category = excluded.category`,
        ).bind(i.basket_item_id, i.label, i.qty, i.mode, i.category),
      ),
    ];
    if (statements.length > 0) await c.env.DB.batch(statements);

    return c.json({ ok: true, mode, items });
  }

  if (body.action === "remove") {
    if (!body.basket_item_id) {
      throw new ApiError(400, "bad_request", "basket_item_id is required to remove a basket item");
    }
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM matches WHERE basket_item_id = ?").bind(body.basket_item_id),
      c.env.DB.prepare("DELETE FROM basket_items WHERE id = ?").bind(body.basket_item_id),
    ]);
    return c.json({ ok: true, removed: body.basket_item_id });
  }

  if (body.action === "update") {
    if (!body.basket_item_id) {
      throw new ApiError(400, "bad_request", "basket_item_id is required to update a basket item");
    }
    const existing = await c.env.DB.prepare("SELECT id, label, qty, category FROM basket_items WHERE id = ?")
      .bind(body.basket_item_id)
      .first<{ id: string; label: string; qty: number; category: string | null }>();
    if (!existing) {
      throw new ApiError(404, "not_found", "basket item not found");
    }
    const label = body.label ?? existing.label;
    const qty = body.qty ?? existing.qty;
    const category = body.category === undefined ? existing.category : body.category;
    await c.env.DB.prepare("UPDATE basket_items SET label = ?, qty = ?, category = ? WHERE id = ?")
      .bind(label, qty, category, body.basket_item_id)
      .run();
    return c.json({ ok: true, item: { basket_item_id: body.basket_item_id, label, qty, category } });
  }

  throw new ApiError(
    400,
    "bad_request",
    "action must be 'add', 'remove', 'update', or 'replace'",
  );
});
