import { beforeEach, describe, expect, it } from "vitest";
import { D1Shim, asD1 } from "./d1-shim";
import { applySchema, resetData } from "./schema-helper";
import { runIngest, validateIngestBody } from "../src/lib/ingest";
import type { Env } from "../src/types";

let shim: D1Shim;
let workerEnv: Env;

beforeEach(() => {
  shim = new D1Shim();
  applySchema(shim);
  resetData(shim);
  workerEnv = { DB: asD1(shim), INGEST_KEY: "test-secret" };
});

const body = {
  retailer_id: "blinkit",
  captured_at: 1_757_000_000_000,
  offers: [
    {
      ext_id: "ext-1",
      name: "Amul Taaza 500ml",
      brand: "Amul",
      size: "500 ml",
      category: "dairy",
      mode: "quick" as const,
      price: 30,
      mrp: 35,
      in_stock: true,
    },
    {
      ext_id: "ext-2",
      name: "Britannia Bread",
      brand: "Britannia",
      category: "bakery",
      mode: "quick" as const,
      price: 45,
      mrp: 50,
      in_stock: true,
    },
  ],
};

async function count(db: D1Shim, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("runIngest", () => {
  it("upserts products, appends prices, and rolls up price_daily", async () => {
    const result = await runIngest(workerEnv, body);
    expect(result.products_upserted).toBe(2);

    expect(await count(shim, "products")).toBe(2);
    expect(await count(shim, "prices")).toBe(2);
    expect(await count(shim, "price_daily")).toBe(2);
  });

  it("is idempotent: re-posting the identical sweep does not duplicate rows", async () => {
    await runIngest(workerEnv, body);
    await runIngest(workerEnv, body);
    await runIngest(workerEnv, body);

    expect(await count(shim, "prices")).toBe(2); // still one row per product, not six
    expect(await count(shim, "products")).toBe(2);
    expect(await count(shim, "price_daily")).toBe(2); // one rollup row per product per day
  });

  it("keeps price_daily min/max correct across multiple sweeps in the same day", async () => {
    const morning = { ...body, captured_at: 1_757_000_000_000, offers: [{ ...body.offers[0]!, price: 30 }] };
    const afternoon = { ...body, captured_at: 1_757_000_000_000 + 3600_000, offers: [{ ...body.offers[0]!, price: 25 }] };
    const evening = { ...body, captured_at: 1_757_000_000_000 + 7200_000, offers: [{ ...body.offers[0]!, price: 40 }] };

    await runIngest(workerEnv, morning);
    await runIngest(workerEnv, afternoon);
    await runIngest(workerEnv, evening);

    const rollup = await shim
      .prepare("SELECT min_price, max_price FROM price_daily WHERE product_id = 'blinkit:ext-1'")
      .first<{ min_price: number; max_price: number }>();
    expect(rollup?.min_price).toBe(25);
    expect(rollup?.max_price).toBe(40);

    const priceRowCount = await shim
      .prepare("SELECT COUNT(*) AS n FROM prices WHERE product_id = 'blinkit:ext-1'")
      .first<{ n: number }>();
    expect(priceRowCount?.n).toBe(3); // three distinct captured_at values, all appended
  });

  it("validateIngestBody rejects malformed payloads", () => {
    expect(() => validateIngestBody({})).toThrow();
    expect(() => validateIngestBody({ retailer_id: "x", captured_at: 1, offers: "nope" })).toThrow();
    expect(() =>
      validateIngestBody({ retailer_id: "x", captured_at: 1, offers: [{ ext_id: "a" }] }),
    ).toThrow();
  });
});
