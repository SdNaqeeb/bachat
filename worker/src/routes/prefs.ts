// GET  /api/prefs -> all current prefs, decoded
// POST /api/prefs -> settings (location, threshold, quiet hours, fees, ...)
//
// Body is a flat map of pref key -> JSON value, e.g.
//   { "threshold_pct": 0.5, "fees.blinkit": { "delivery": 20, "handling": 0, "eta_minutes": 15 } }
// Any subset of keys may be sent; unlisted keys are left untouched.
//
// Object-valued prefs are merged ONE level deep against what is already
// stored. This matters: the app's Settings screen edits delivery/handling fees
// but has no UI for `eta_minutes`, and a blind overwrite would silently delete
// the ETA the basket screen renders. Scalars and arrays are replaced whole.

import { Hono } from "hono";
import type { Env } from "../types";
import { ApiError } from "../types";

export const prefs = new Hono<{ Bindings: Env }>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One-level merge when both sides are objects; otherwise the incoming wins. */
function mergeValue(storedRaw: string | undefined, incoming: unknown): unknown {
  if (storedRaw === undefined || !isPlainObject(incoming)) return incoming;
  let stored: unknown;
  try {
    stored = JSON.parse(storedRaw);
  } catch {
    return incoming;
  }
  if (!isPlainObject(stored)) return incoming;
  return { ...stored, ...incoming };
}

prefs.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, value FROM prefs").all<{
    key: string;
    value: string;
  }>();
  const out: Record<string, unknown> = {};
  for (const row of results ?? []) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return c.json({ prefs: out });
});

prefs.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "bad_request", "body must be an object of pref key/value pairs");
  }
  const entries = Object.entries(body);
  if (entries.length === 0) {
    throw new ApiError(400, "bad_request", "at least one pref key is required");
  }

  const { results: existingRows } = await c.env.DB.prepare(
    "SELECT key, value FROM prefs",
  ).all<{ key: string; value: string }>();
  const existing = new Map((existingRows ?? []).map((r) => [r.key, r.value]));

  const statements = entries.map(([key, value]) =>
    c.env.DB.prepare(
      "INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(key, JSON.stringify(mergeValue(existing.get(key), value))),
  );
  await c.env.DB.batch(statements);

  // Return the FULL stored map, not just an ack: the app treats a settings
  // write as "save and re-read", and a second round trip to see what actually
  // landed (after the merge above) is a needless one.
  const { results: after } = await c.env.DB.prepare("SELECT key, value FROM prefs").all<{
    key: string;
    value: string;
  }>();
  const out: Record<string, unknown> = {};
  for (const row of after ?? []) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }

  return c.json({ ok: true, updated: entries.map(([key]) => key), prefs: out });
});
