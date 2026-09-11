// Contract tests for everything the mobile app depends on, and the honest
// capture of the wire fixtures the app's decoder tests run against.
//
// The fixtures written at the bottom of this file are NOT hand-written: every
// one of them is the byte-for-byte body of a real `app.request(...)` against
// the real Hono app and the real schema.sql, with the clock frozen so the
// output is reproducible. If a route's shape changes, these files change, and
// the mobile decoder tests that read them fail — which is the whole point.

import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "../src/index";
import { D1Shim, asD1 } from "./d1-shim";
import { applySchema, resetData } from "./schema-helper";
import type { Env } from "../src/types";

// Frozen so captured_at, ages and day strings are identical on every run.
const NOW = Date.parse("2026-09-12T09:00:00.000Z");
const HOUR = 3600_000;

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "mobile",
  "src",
  "lib",
  "__tests__",
  "fixtures",
  "wire",
);

const captured: Record<string, unknown> = {};

let shim: D1Shim;
let env: Env;

function dayStr(daysAgo: number): string {
  return new Date(NOW - daysAgo * 24 * HOUR).toISOString().slice(0, 10);
}

function run(sql: string, ...params: unknown[]) {
  return shim.prepare(sql).bind(...params).run();
}

async function seed() {
  // A third quick retailer so the basket fixture has a winner, a runner-up AND
  // a partially stocked retailer that must never be allowed to win (spec §8).
  await run(
    "INSERT OR IGNORE INTO retailers (id, name, mode, deeplink_tpl) VALUES ('instamart','Instamart','quick','instamart://p/{ext_id}')",
  );

  const products: [string, string, string, string, string | null, string | null, string | null, string, string][] = [
    // id, retailer, ext_id, name, brand, size, pack, category, mode
    ["blinkit:milk", "blinkit", "milk", "Amul Taaza Toned Milk", "Amul", null, "500 ml", "dairy", "quick"],
    ["blinkit:bread", "blinkit", "bread", "Britannia Brown Bread", "Britannia", null, "400 g", "bakery", "quick"],
    ["bigbasket:milk", "bigbasket", "milk", "Amul Taaza Toned Milk", "Amul", null, "500 ml", "dairy", "quick"],
    ["bigbasket:bread", "bigbasket", "bread", "Britannia Brown Bread", "Britannia", null, "400 g", "bakery", "quick"],
    ["instamart:milk", "instamart", "milk", "Amul Taaza Toned Milk", "Amul", null, "500 ml", "dairy", "quick"],
    ["myntra:tee", "myntra", "tee", "Nike Dri-FIT Tee", "Nike", "M", null, "tshirts", "fashion"],
    ["amazon:tee", "amazon", "tee", "Levis Cotton Tee", "Levis", "L", null, "tshirts", "fashion"],
  ];
  for (const [id, retailer, extId, name, brand, size, pack, category, mode] of products) {
    await run(
      `INSERT INTO products (id, retailer_id, ext_id, name, brand, size, pack, image_url, url, category, mode)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      retailer,
      extId,
      name,
      brand,
      size,
      pack,
      `https://img.invalid/${id}.jpg`,
      `https://${retailer}.invalid/p/${extId}`,
      category,
      mode,
    );
  }

  const prices: [string, number, number | null, number, number][] = [
    // product, price, mrp, in_stock, captured_at
    ["blinkit:milk", 28, 35, 1, NOW - 2 * HOUR],
    ["blinkit:bread", 45, 55, 1, NOW - 2 * HOUR],
    ["bigbasket:milk", 30, 35, 1, NOW - 3 * HOUR],
    ["bigbasket:bread", 44, 55, 1, NOW - 3 * HOUR],
    // instamart is cheapest per item but has no bread at all: it must be shown
    // with its gap stated and must never win.
    ["instamart:milk", 24, 35, 1, NOW - 40 * HOUR],
    ["myntra:tee", 1499, 2999, 1, NOW - 5 * HOUR],
    ["amazon:tee", 899, 1999, 0, NOW - 5 * HOUR],
  ];
  for (const [productId, price, mrp, inStock, capturedAt] of prices) {
    await run(
      "INSERT INTO prices (product_id, price, mrp, in_stock, captured_at) VALUES (?,?,?,?,?)",
      productId,
      price,
      mrp,
      inStock,
      capturedAt,
    );
  }

  // blinkit:milk has 12 days of history: the honesty rule's "lowest in 12
  // days" case (spec §7). Today's row is at the current price, so it IS a low.
  for (let i = 0; i < 12; i++) {
    await run(
      "INSERT INTO price_daily (product_id, day, min_price, max_price) VALUES (?,?,?,?)",
      "blinkit:milk",
      dayStr(i),
      i === 0 ? 28 : 30 + (i % 5),
      35,
    );
  }
  // bigbasket:milk has a full 30 days and is NOT at its low.
  for (let i = 0; i < 30; i++) {
    await run(
      "INSERT INTO price_daily (product_id, day, min_price, max_price) VALUES (?,?,?,?)",
      "bigbasket:milk",
      dayStr(i),
      i === 17 ? 22 : 30,
      35,
    );
  }
  // blinkit:bread deliberately has NO price_daily rows at all — the
  // "no price history yet" case the app must not dress up as a 30-day low.

  await run(
    "INSERT INTO alerts (id, product_id, kind, price, sent_at) VALUES ('a1','blinkit:milk','period_low',28,?)",
    NOW - 6 * HOUR,
  );

  await run(
    "INSERT INTO basket_items (id, label, qty, mode, category) VALUES ('i-milk','Amul Taaza 500 ml',2,'quick','dairy')",
  );
  await run(
    "INSERT INTO basket_items (id, label, qty, mode, category) VALUES ('i-bread','Brown Bread',1,'quick','bakery')",
  );
  for (const [item, product] of [
    ["i-milk", "blinkit:milk"],
    ["i-milk", "bigbasket:milk"],
    ["i-milk", "instamart:milk"],
    ["i-bread", "blinkit:bread"],
    ["i-bread", "bigbasket:bread"],
  ]) {
    await run(
      "INSERT INTO matches (basket_item_id, product_id, confidence) VALUES (?,?,1)",
      item,
      product,
    );
  }
}

async function get(url: string): Promise<any> {
  const res = await app.request(url, {}, env);
  expect(res.status, `${url} should be 200`).toBe(200);
  return res.json();
}

/** Captures a real response body under `name` for the mobile decoder tests. */
async function capture(name: string, url: string): Promise<any> {
  const body = await get(url);
  captured[name] = body;
  return body;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  shim = new D1Shim();
  applySchema(shim);
  resetData(shim);
  env = { DB: asD1(shim), INGEST_KEY: "test-secret" };
  await seed();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/health", () => {
  it("rolls sweeps up per mode and reports catalog and push health", async () => {
    const body = await capture("health", "/api/health");

    // Both modes have a fresh retailer, but instamart's 40h-old sweep is
    // enough on its own to stop the app claiming everything is current.
    expect(body.status).toBe("degraded");
    expect(body.stale_sweep).toBe(true);
    expect(body.modes.quick.stale).toBe(false);
    expect(body.modes.quick.last_sweep_at).toBe(NOW - 2 * HOUR);
    expect(body.modes.quick.retailer_count).toBe(3);
    expect(body.modes.fashion.last_sweep_at).toBe(NOW - 5 * HOUR);
    expect(body.product_count).toBe(7);
    expect(body.retailer_count).toBe(6);
    expect(body.last_push_sent_at).toBe(NOW - 6 * HOUR);

    const instamart = body.retailers.find((r: any) => r.id === "instamart");
    expect(instamart.stale).toBe(true); // 40h old against a 6h quick threshold
  });

  it("says a mode has never been swept rather than inventing a timestamp", async () => {
    resetData(shim);
    const body = await get("/api/health");
    expect(body.modes.quick.last_sweep_at).toBeNull();
    expect(body.modes.quick.stale).toBe(true);
    expect(body.last_push_sent_at).toBeNull();
    expect(body.status).toBe("degraded");
  });
});

describe("GET /api/facets", () => {
  it("returns the retailers and categories the filter pickers need", async () => {
    const fashion = await capture("facets-fashion", "/api/facets?mode=fashion");
    expect(fashion.retailers.map((r: any) => r.id)).toEqual(["amazon", "flipkart", "myntra"]);
    expect(fashion.categories).toEqual([{ id: "tshirts", mode: "fashion", product_count: 2 }]);
    expect(fashion.brands).toEqual(["Levis", "Nike"]);
    expect(fashion.sizes).toEqual(["L", "M"]);

    const quick = await capture("facets-quick", "/api/facets?mode=quick");
    expect(quick.retailers.map((r: any) => r.id)).toEqual(["bigbasket", "blinkit", "instamart"]);
    expect(quick.categories.map((c: any) => c.id)).toEqual(["bakery", "dairy"]);
    // Quick commerce has no fashion facets, and must not borrow fashion's.
    expect(quick.sizes).toEqual([]);
  });
});

describe("GET /api/basket", () => {
  it("carries product detail and a deeplink on every priced line", async () => {
    const body = await capture("basket-quick", "/api/basket?mode=quick");

    const blinkit = body.retailers.find((r: any) => r.retailer_id === "blinkit");
    const line = blinkit.lines.find((l: any) => l.basket_item_id === "i-milk");
    expect(line.status).toBe("priced");
    expect(line.deeplink).toBe("blinkit://product/milk?utm_source=bachat");
    expect(line.brand).toBe("Amul");
    expect(line.pack).toBe("500 ml");
    expect(line.url).toBe("https://blinkit.invalid/p/milk");

    // Instamart is cheapest per item but is missing bread entirely.
    const instamart = body.retailers.find((r: any) => r.retailer_id === "instamart");
    expect(instamart.fully_stocked).toBe(false);
    expect(instamart.missing_items).toEqual([{ basket_item_id: "i-bread", label: "Brown Bread" }]);
    expect(body.ranking.eligible_for_win).toEqual(["blinkit", "bigbasket"]);
    expect(body.ranking.winner.retailer_id).toBe("blinkit");
    expect(body.ranking.runner_up.retailer_id).toBe("bigbasket");
  });
});

describe("POST /api/basket action=replace", () => {
  it("sets the whole basket for a mode in one round trip", async () => {
    const res = await app.request(
      "/api/basket",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "replace",
          mode: "quick",
          items: [
            { basket_item_id: "i-milk", label: "Amul Taaza 500 ml", qty: 3, category: "dairy" },
            { label: "Eggs (6)", qty: 1, category: "dairy" },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    captured["basket-replace"] = {
      ...body,
      // The server-assigned id is a UUID; blank it so the fixture is stable.
      items: body.items.map((i: any) => (i.label === "Eggs (6)" ? { ...i, basket_item_id: "<uuid>" } : i)),
    };

    expect(body.items).toHaveLength(2);
    expect(body.items[0].qty).toBe(3);

    const rows = await shim
      .prepare("SELECT id, label, qty FROM basket_items WHERE mode = 'quick' ORDER BY label")
      .all<{ id: string; label: string; qty: number }>();
    // i-bread is gone, i-milk is updated in place, Eggs is new.
    expect(rows.results.map((r) => r.label)).toEqual(["Amul Taaza 500 ml", "Eggs (6)"]);
    expect(rows.results[0]?.id).toBe("i-milk");
    // Removing an item must not leave its matches behind.
    const orphans = await shim
      .prepare("SELECT COUNT(*) AS n FROM matches WHERE basket_item_id = 'i-bread'")
      .first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });

  it("rejects an item with no label rather than storing a blank row", async () => {
    const res = await app.request(
      "/api/basket",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "replace", mode: "quick", items: [{ qty: 2 }] }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/deals and /api/compare", () => {
  it("echo the mode and carry a period-low claim per item", async () => {
    const body = await capture("deals-quick", "/api/deals?mode=quick&limit=5");
    expect(body.mode).toBe("quick");
    expect(body.swept_at).toBe(NOW - 2 * HOUR);

    const milk = body.items.find((i: any) => i.product_id === "blinkit:milk");
    expect(milk.period_low.days_observed).toBe(12);
    expect(milk.period_low.claim).toBe("lowest in 12 days");
    expect(milk.size).toBeNull();
    expect(milk.pack).toBe("500 ml");

    const bread = body.items.find((i: any) => i.product_id === "blinkit:bread");
    expect(bread.period_low.days_observed).toBe(0);
    expect(bread.period_low.claim).toBe("no price history yet");

    const compare = await capture("compare-quick", "/api/compare?mode=quick&q=Amul");
    expect(compare.results).toHaveLength(3);
    expect(compare.results[0].category).toBe("dairy");
    expect(compare.results[0].mode).toBe("quick");
    expect(compare.swept_at).toBe(NOW - 2 * HOUR);

    await capture("compare-fashion", "/api/compare?mode=fashion&q=Tee");
  });
});

describe("GET /api/history/:productId", () => {
  it("captures both the partial-history and the no-history cases", async () => {
    const partial = await capture("history-partial", "/api/history/blinkit:milk?days=30");
    expect(partial.days_observed).toBe(12);
    expect(partial.period_low.claim).toBe("lowest in 12 days");
    expect(partial.period_low.claim).not.toContain("30");

    const none = await capture("history-empty", "/api/history/blinkit:bread?days=30");
    expect(none.days_observed).toBe(0);
    expect(none.period_low.is_period_low).toBe(false);
    expect(none.period_low.claim).toBe("no price history yet");

    const full = await capture("history-full", "/api/history/bigbasket:milk?days=30");
    expect(full.days_observed).toBe(30);
    expect(full.period_low.is_period_low).toBe(false);
  });
});

describe("POST /api/prefs", () => {
  it("merges object-valued prefs one level deep so eta_minutes survives a fee edit", async () => {
    const res = await app.request(
      "/api/prefs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "fees.blinkit": { delivery: 20, handling: 5 } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    // The POST answers with the full stored map, so the app does not need a
    // second GET just to see what its write actually landed on.
    const posted = (await res.json()) as any;
    expect(posted.prefs["fees.blinkit"]).toEqual({ delivery: 20, handling: 5, eta_minutes: 15 });
    expect(posted.updated).toEqual(["fees.blinkit"]);

    const body = await capture("prefs", "/api/prefs");
    expect(body.prefs["fees.blinkit"]).toEqual({ delivery: 20, handling: 5, eta_minutes: 15 });
  });

  it("replaces scalars and arrays whole", async () => {
    await app.request(
      "/api/prefs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold_pct: 0.4, enabled_categories: ["dairy"] }),
      },
      env,
    );
    const body = await get("/api/prefs");
    expect(body.prefs.threshold_pct).toBe(0.4);
    expect(body.prefs.enabled_categories).toEqual(["dairy"]);
  });
});

describe("error bodies", () => {
  it("are shaped { error: { code, message } }", async () => {
    const res = await app.request("/api/history/nope", {}, env);
    expect(res.status).toBe(404);
    captured["error-404"] = await res.json();
    expect((captured["error-404"] as any).error.code).toBe("not_found");
  });
});

// Written once, after every route above has produced a real response.
afterAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const [name, body] of Object.entries(captured)) {
    writeFileSync(
      path.join(FIXTURE_DIR, `${name}.json`),
      `${JSON.stringify(body, null, 2)}\n`,
      "utf-8",
    );
  }
  writeFileSync(
    path.join(FIXTURE_DIR, "README.md"),
    [
      "# Captured wire fixtures",
      "",
      "Generated — do not edit by hand.",
      "",
      "Every file here is the real response body of a real request against the",
      "Cloudflare Worker's Hono app (`worker/src/index.ts`) and the real",
      "`worker/schema.sql`, captured by `worker/test/contract.test.ts` with the",
      "clock frozen at 2026-09-12T09:00:00.000Z.",
      "",
      "Regenerate with `cd worker && npm test`. If a route's shape changes, these",
      "files change and `mobile/src/lib/__tests__/decode.contract.test.ts` fails.",
      "",
    ].join("\n"),
    "utf-8",
  );
});
