// POST /api/history/bulk — the sweep's replacement for N per-product round
// trips (spec section 12's ~6 minute budget).
//
// The honesty rule (spec section 7) is the thing these tests actually guard:
// the bulk route must report the SAME real days_observed as the single-product
// route for every product, with no defaulting to 30, no padding of a short
// series, and no period-low claim it cannot substantiate.

import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { D1Shim, asD1 } from "./d1-shim";
import { applySchema, resetData } from "./schema-helper";
import type { Env } from "../src/types";

let shim: D1Shim;
let env: Env;

const NOW = Date.now();
const DAY = 86_400_000;

function dayStr(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);
}

function run(sql: string, ...params: unknown[]) {
  return shim.prepare(sql).bind(...params).run();
}

async function addProduct(id: string, price: number, capturedAt = NOW) {
  const [retailer, extId] = id.split(":");
  await run(
    "INSERT INTO products (id, retailer_id, ext_id, name, mode, category) VALUES (?,?,?,?,'quick','dairy')",
    id,
    retailer,
    extId,
    `product ${extId}`,
  );
  await run(
    "INSERT INTO prices (product_id, price, mrp, in_stock, captured_at) VALUES (?,?,?,1,?)",
    id,
    price,
    price * 2,
    capturedAt,
  );
}

async function addDaily(id: string, days: number, minPrice: (i: number) => number) {
  for (let i = 0; i < days; i++) {
    await run(
      "INSERT INTO price_daily (product_id, day, min_price, max_price) VALUES (?,?,?,?)",
      id,
      dayStr(i),
      minPrice(i),
      99,
    );
  }
}

async function bulk(body: unknown): Promise<Response> {
  return app.request(
    "/api/history/bulk",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

async function json(res: Response) {
  return res.json() as Promise<any>;
}

beforeEach(() => {
  shim = new D1Shim();
  applySchema(shim);
  resetData(shim);
  env = { DB: asD1(shim), INGEST_KEY: "test-secret" };
});

describe("POST /api/history/bulk", () => {
  it("returns the same days_observed the single-product route does", async () => {
    await addProduct("blinkit:milk", 28);
    await addDaily("blinkit:milk", 12, (i) => (i === 0 ? 28 : 30 + (i % 5)));
    await addProduct("bigbasket:milk", 30);
    await addDaily("bigbasket:milk", 30, (i) => (i === 17 ? 22 : 30));
    await addProduct("blinkit:bread", 45); // deliberately no price_daily rows

    const ids = ["blinkit:milk", "bigbasket:milk", "blinkit:bread"];
    const body = await json(await bulk({ product_ids: ids, days: 30 }));
    const byId = new Map(body.items.map((i: any) => [i.product_id, i]));

    for (const id of ids) {
      const single = await json(await app.request(`/api/history/${id}?days=30`, {}, env));
      const fromBulk = byId.get(id) as any;
      expect(fromBulk.days_observed, id).toBe(single.days_observed);
      expect(fromBulk.series, id).toEqual(single.series);
      expect(fromBulk.period_low, id).toEqual(single.period_low);
      expect(fromBulk.current_price, id).toBe(single.current_price);
      expect(fromBulk.current_captured_at, id).toBe(single.current_captured_at);
    }

    expect((byId.get("blinkit:milk") as any).days_observed).toBe(12);
    expect((byId.get("blinkit:milk") as any).period_low.claim).toBe("lowest in 12 days");
    expect((byId.get("bigbasket:milk") as any).days_observed).toBe(30);
  });

  it("never defaults a missing count to 30 or pads a short series", async () => {
    await addProduct("blinkit:bread", 45);
    const body = await json(await bulk({ product_ids: ["blinkit:bread"], days: 30 }));
    const item = body.items[0];
    expect(item.days_observed).toBe(0);
    expect(item.series).toEqual([]);
    expect(item.period_low.is_period_low).toBe(false);
    expect(item.period_low.claim).toBe("no price history yet");
    expect(JSON.stringify(item)).not.toContain("30-day");
  });

  it("carries days_observed on every item, so a decoder may refuse a missing one", async () => {
    await addProduct("blinkit:a", 10);
    await addDaily("blinkit:a", 3, () => 10);
    await addProduct("blinkit:b", 20);
    const body = await json(await bulk({ product_ids: ["blinkit:a", "blinkit:b"] }));
    for (const item of body.items) {
      expect(Number.isInteger(item.days_observed)).toBe(true);
      expect(item.days_observed).toBe(item.series.length);
      if (item.period_low) {
        expect(item.period_low.days_observed).toBe(item.days_observed);
      }
    }
  });

  it("excludes rows outside the requested window from days_observed", async () => {
    await addProduct("blinkit:old", 10);
    await addDaily("blinkit:old", 40, () => 10);
    const body = await json(await bulk({ product_ids: ["blinkit:old"], days: 7 }));
    expect(body.items[0].days_observed).toBe(8); // today + 7 prior days
    expect(body.items[0].period_low.claim).toBe("lowest in 7 days");
  });

  it("reports unknown product ids as missing, not as products with no history", async () => {
    await addProduct("blinkit:milk", 28);
    const body = await json(await bulk({ product_ids: ["blinkit:milk", "blinkit:ghost"] }));
    expect(body.items.map((i: any) => i.product_id)).toEqual(["blinkit:milk"]);
    expect(body.missing).toEqual(["blinkit:ghost"]);
  });

  it("handles more ids than fit in one SQL statement's bound parameters", async () => {
    // 200 ids spans three internal chunks of 90. If the route were looping one
    // query per product, or overflowing D1's 100-parameter cap, this breaks.
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = `blinkit:p${i}`;
      ids.push(id);
      await addProduct(id, 10 + i);
      await addDaily(id, (i % 5) + 1, () => 10 + i);
    }
    const body = await json(await bulk({ product_ids: ids, days: 30 }));
    expect(body.items).toHaveLength(200);
    expect(body.missing).toEqual([]);
    for (const item of body.items) {
      const i = Number(item.product_id.slice("blinkit:p".length));
      expect(item.days_observed).toBe((i % 5) + 1);
    }
  });

  it("de-duplicates repeated ids instead of answering twice", async () => {
    await addProduct("blinkit:milk", 28);
    const body = await json(await bulk({ product_ids: ["blinkit:milk", "blinkit:milk"] }));
    expect(body.requested).toBe(1);
    expect(body.items).toHaveLength(1);
  });

  it("refuses a body that is not a product id list", async () => {
    expect((await bulk({})).status).toBe(400);
    expect((await bulk({ product_ids: "blinkit:milk" })).status).toBe(400);
  });

  it("caps the number of ids per request", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `blinkit:p${i}`);
    expect((await bulk({ product_ids: ids })).status).toBe(400);
  });

  it("answers an empty list with an empty result, not an error", async () => {
    const res = await bulk({ product_ids: [] });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.items).toEqual([]);
    expect(body.missing).toEqual([]);
  });
});
