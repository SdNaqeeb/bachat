// GET /api/health — sweep freshness per retailer AND per mode, staleness ages,
// catalog counts, and push-delivery health (spec section 10).
//
// The per-retailer array is the raw truth; the `modes` rollup and the counts
// exist because the app's Settings screen needs a mode-level answer ("quick
// prices are 4 hours old") and cannot honestly derive one without knowing
// which retailers belong to which mode.

import { Hono } from "hono";
import type { Env, Mode } from "../types";
import { ageSeconds } from "../lib/dates";

// Sweep cadence (spec section 12): quick every 4h, fashion 2x/day (~12h).
// Stale thresholds give one missed sweep of slack before flagging.
const STALE_THRESHOLD_SECONDS: Record<string, number> = {
  quick: 6 * 3600,
  fashion: 18 * 3600,
};

type Row = {
  id: string;
  name: string;
  mode: "quick" | "fashion";
  last_sweep_at: number | null;
  product_count: number;
};

export const health = new Hono<{ Bindings: Env }>();

health.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT
       r.id, r.name, r.mode,
       (SELECT MAX(p.captured_at) FROM prices p
          JOIN products pr ON pr.id = p.product_id
          WHERE pr.retailer_id = r.id) AS last_sweep_at,
       (SELECT COUNT(*) FROM products pr WHERE pr.retailer_id = r.id) AS product_count
     FROM retailers r
     ORDER BY r.id`,
  ).all<Row>();

  const now = Date.now();
  const retailers = (results ?? []).map((r) => {
    const threshold = STALE_THRESHOLD_SECONDS[r.mode] ?? 6 * 3600;
    const age = r.last_sweep_at == null ? null : ageSeconds(r.last_sweep_at, now);
    return {
      id: r.id,
      name: r.name,
      mode: r.mode,
      last_sweep_at: r.last_sweep_at,
      age_seconds: age,
      stale: age == null ? true : age > threshold,
      product_count: r.product_count,
    };
  });

  // Mode-level rollup. `last_sweep_at` for a mode is the NEWEST sweep of any
  // retailer in that mode; a mode is stale when every retailer in it is stale
  // (or when it has no retailers at all — nothing fresh has ever arrived).
  const modes = {} as Record<Mode, { last_sweep_at: number | null; stale: boolean; retailer_count: number }>;
  for (const mode of ["quick", "fashion"] as Mode[]) {
    const inMode = retailers.filter((r) => r.mode === mode);
    const sweeps = inMode
      .map((r) => r.last_sweep_at)
      .filter((v): v is number => typeof v === "number");
    modes[mode] = {
      last_sweep_at: sweeps.length > 0 ? Math.max(...sweeps) : null,
      stale: inMode.length === 0 || inMode.every((r) => r.stale),
      retailer_count: inMode.length,
    };
  }

  const productRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM products").first<{
    n: number;
  }>();
  const product_count = productRow?.n ?? 0;

  // Delivery health (spec section 10): the last push the SERVER sent. The app
  // pairs this with the last push the DEVICE received to expose OEM battery
  // managers silently dropping wake broadcasts.
  const pushRow = await c.env.DB.prepare("SELECT MAX(sent_at) AS t FROM alerts").first<{
    t: number | null;
  }>();
  const last_push_sent_at = pushRow?.t ?? null;

  // Degraded the moment ANY retailer's prices are older than its cadence
  // allows: the app has to be able to say "these prices are old" rather than
  // quietly showing stale numbers as if they were current (spec section 9).
  const stale_sweep =
    retailers.some((r) => r.stale) || Object.values(modes).some((m) => m.stale);

  return c.json({
    status: stale_sweep ? "degraded" : "ok",
    retailers,
    modes,
    stale_sweep,
    product_count,
    retailer_count: retailers.length,
    last_push_sent_at,
    now,
  });
});
