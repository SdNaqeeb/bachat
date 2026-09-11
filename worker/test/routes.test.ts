// Route-level tests: exercise the actual Hono app (src/index.ts) end to end
// against the D1 shim, covering the wiring between routes and the ranking /
// honesty-rule modules, not just the pure functions in isolation.

import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { D1Shim, asD1 } from "./d1-shim";
import { applySchema, resetData } from "./schema-helper";
import type { Env } from "../src/types";

let shim: D1Shim;
let env: Env;

beforeEach(() => {
  shim = new D1Shim();
  applySchema(shim);
  resetData(shim);
  env = { DB: asD1(shim), INGEST_KEY: "test-secret" };
});

async function json(res: Response) {
  return res.json() as Promise<any>;
}

describe("GET /api/basket", () => {
  it("prices a basket, states a retailer's gap, and ranks by total (not item price)", async () => {
    await shim
      .prepare("INSERT INTO basket_items (id, label, qty, mode, category) VALUES (?,?,?,?,?)")
      .bind("i1", "Amul Taaza 500ml", 1, "quick", "dairy")
      .run();
    await shim
      .prepare("INSERT INTO basket_items (id, label, qty, mode, category) VALUES (?,?,?,?,?)")
      .bind("i2", "Bread", 1, "quick", "bakery")
      .run();

    // blinkit: has both items, cheap items but higher delivery fee
    await shim
      .prepare(
        "INSERT INTO products (id, retailer_id, ext_id, name, brand, mode, category) VALUES (?,?,?,?,?,?,?)",
      )
      .bind("blinkit:1", "blinkit", "1", "Amul Taaza 500ml", "Amul", "quick", "dairy")
      .run();
    await shim
      .prepare(
        "INSERT INTO products (id, retailer_id, ext_id, name, brand, mode, category) VALUES (?,?,?,?,?,?,?)",
      )
      .bind("blinkit:2", "blinkit", "2", "Bread", "Britannia", "quick", "bakery")
      .run();
    await shim
      .prepare("INSERT INTO prices (product_id, price, mrp, in_stock, captured_at) VALUES (?,?,?,?,?)")
      .bind("blinkit:1", 30, 35, 1, Date.now())
      .run();
    await shim
      .prepare("INSERT INTO prices (product_id, price, mrp, in_stock, captured_at) VALUES (?,?,?,?,?)")
      .bind("blinkit:2", 20, 25, 1, Date.now())
      .run();
    await shim
      .prepare("INSERT INTO matches (basket_item_id, product_id, confidence) VALUES (?,?,1)")
      .bind("i1", "blinkit:1")
      .run();
    await shim
      .prepare("INSERT INTO matches (basket_item_id, product_id, confidence) VALUES (?,?,1)")
      .bind("i2", "blinkit:2")
      .run();

    // bigbasket: only has item i1 (missing bread) even though it's cheaper per-item
    await shim
      .prepare(
        "INSERT INTO products (id, retailer_id, ext_id, name, brand, mode, category) VALUES (?,?,?,?,?,?,?)",
      )
      .bind("bigbasket:1", "bigbasket", "1", "Amul Taaza 500ml", "Amul", "quick", "dairy")
      .run();
    await shim
      .prepare("INSERT INTO prices (product_id, price, mrp, in_stock, captured_at) VALUES (?,?,?,?,?)")
      .bind("bigbasket:1", 1, 35, 1, Date.now())
      .run();
    await shim
      .prepare("INSERT INTO matches (basket_item_id, product_id, confidence) VALUES (?,?,1)")
      .bind("i1", "bigbasket:1")
      .run();

    const res = await app.request("/api/basket?mode=quick", {}, env);
    expect(res.status).toBe(200);
    const body = await json(res);

    const bigbasket = body.retailers.find((r: any) => r.retailer_id === "bigbasket");
    expect(bigbasket.fully_stocked).toBe(false);
    expect(bigbasket.missing_items).toEqual([{ basket_item_id: "i2", label: "Bread" }]);

    // blinkit is the only fully-stocked retailer, so it wins outright even
    // though bigbasket's single item was far cheaper.
    expect(body.ranking.winner.retailer_id).toBe("blinkit");
    expect(body.ranking.eligible_for_win).toEqual(["blinkit"]);
  });
});

describe("GET /api/history/:productId", () => {
  it("reports the true days_observed and never claims a false 30-day low", async () => {
    await shim
      .prepare(
        "INSERT INTO products (id, retailer_id, ext_id, name, mode) VALUES ('blinkit:1','blinkit','1','Amul Taaza','quick')",
      )
      .run();
    await shim
      .prepare("INSERT INTO prices (product_id, price, mrp, in_stock, captured_at) VALUES (?,?,?,?,?)")
      .bind("blinkit:1", 28, 35, 1, Date.now())
      .run();

    const today = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const day = d.toISOString().slice(0, 10);
      await shim
        .prepare("INSERT INTO price_daily (product_id, day, min_price, max_price) VALUES (?,?,?,?)")
        .bind("blinkit:1", day, 28 + i, 35)
        .run();
    }

    const res = await app.request("/api/history/blinkit:1?days=30", {}, env);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.days_observed).toBe(12);
    expect(body.period_low.claim).toBe("lowest in 12 days");
    expect(body.period_low.claim).not.toContain("30");
  });

  it("404s for an unknown product", async () => {
    const res = await app.request("/api/history/nope", {}, env);
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error.code).toBe("not_found");
  });
});

describe("POST /api/ingest", () => {
  it("rejects requests without the shared secret", async () => {
    const res = await app.request(
      "/api/ingest",
      { method: "POST", body: JSON.stringify({ retailer_id: "blinkit", captured_at: 1, offers: [] }) },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("accepts and is idempotent through the HTTP layer", async () => {
    const payload = {
      retailer_id: "blinkit",
      captured_at: Date.now(),
      offers: [
        { ext_id: "1", name: "Amul Taaza", mode: "quick", price: 30, mrp: 35, in_stock: true },
      ],
    };
    const headers = { "X-Ingest-Key": "test-secret", "Content-Type": "application/json" };

    const res1 = await app.request("/api/ingest", { method: "POST", headers, body: JSON.stringify(payload) }, env);
    expect(res1.status).toBe(200);
    const res2 = await app.request("/api/ingest", { method: "POST", headers, body: JSON.stringify(payload) }, env);
    expect(res2.status).toBe(200);

    const row = await shim.prepare("SELECT COUNT(*) AS n FROM prices").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
