// GET  /api/categories?mode= -> the sweepable category catalog.
// POST /api/categories        -> upsert catalog entries.
//
// Why this route exists: `prefs.enabled_categories` is a flat list of slugs
// (the app decodes it as a list of strings, and that shape is fixed), so
// nothing in it says whether "fashion-tops" is a fashion category. The
// collector used to infer that from the "fashion-" name prefix. A naming
// convention is not data: rename a slug and the sweep silently changes
// behaviour. This catalog carries `mode` as a column, and a slug the catalog
// does not know has NO mode — the sweep skips it loudly rather than guessing.
//
// `/api/facets` also returns categories, but those are derived from products
// already collected, so it is empty before the first sweep and can never tell
// a sweep which categories to go and collect. This is the catalog; that is
// the inventory.

import { Hono } from "hono";
import type { Env, Mode } from "../types";
import { ApiError } from "../types";

export const categories = new Hono<{ Bindings: Env }>();

type CategoryRow = { slug: string; label: string; mode: Mode };

categories.get("/", async (c) => {
  const mode = c.req.query("mode");
  if (mode !== undefined && mode !== "quick" && mode !== "fashion") {
    throw new ApiError(400, "bad_request", "mode must be 'quick' or 'fashion'");
  }

  const stmt = mode
    ? c.env.DB.prepare(
        "SELECT slug, label, mode FROM categories WHERE mode = ? ORDER BY slug",
      ).bind(mode)
    : c.env.DB.prepare("SELECT slug, label, mode FROM categories ORDER BY slug");

  const { results } = await stmt.all<CategoryRow>();
  return c.json({ mode: mode ?? null, categories: results ?? [] });
});

categories.post("/", async (c) => {
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "bad_request", "body must be { categories: [...] }");
  }
  const list = (raw as { categories?: unknown }).categories;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ApiError(400, "bad_request", "categories must be a non-empty array");
  }

  const rows = list.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new ApiError(400, "bad_request", `categories[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.slug !== "string" || !e.slug) {
      throw new ApiError(400, "bad_request", `categories[${i}].slug is required`);
    }
    if (e.mode !== "quick" && e.mode !== "fashion") {
      throw new ApiError(400, "bad_request", `categories[${i}].mode must be 'quick' or 'fashion'`);
    }
    return {
      slug: e.slug,
      label: typeof e.label === "string" && e.label ? e.label : e.slug,
      mode: e.mode as Mode,
    };
  });

  await c.env.DB.batch(
    rows.map((r) =>
      c.env.DB.prepare(
        `INSERT INTO categories (slug, label, mode) VALUES (?,?,?)
         ON CONFLICT(slug) DO UPDATE SET label = excluded.label, mode = excluded.mode`,
      ).bind(r.slug, r.label, r.mode),
    ),
  );

  const { results } = await c.env.DB.prepare(
    "SELECT slug, label, mode FROM categories ORDER BY slug",
  ).all<CategoryRow>();

  return c.json({ ok: true, updated: rows.map((r) => r.slug), categories: results ?? [] });
});
