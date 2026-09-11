// Tests for the alert log and the quiet-hours hold queue (spec section 7).
//
// The point of these routes is that the sweep is a FRESH PROCESS every run:
// dedupe state and held alerts have to survive a process exit, and "held
// until morning, never dropped" is only true if the queue is durable.

import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { D1Shim, asD1 } from "./d1-shim";
import { applySchema, resetData } from "./schema-helper";
import type { Env } from "../src/types";

let shim: D1Shim;
let env: Env;

const KEY = { "X-Ingest-Key": "test-secret", "Content-Type": "application/json" };

beforeEach(async () => {
  shim = new D1Shim();
  applySchema(shim);
  resetData(shim);
  env = { DB: asD1(shim), INGEST_KEY: "test-secret" };
  await shim
    .prepare(
      "INSERT INTO products (id, retailer_id, ext_id, name, mode, category) VALUES ('blinkit:milk','blinkit','milk','Amul Taaza','quick','dairy')",
    )
    .run();
  await shim
    .prepare(
      "INSERT INTO products (id, retailer_id, ext_id, name, mode, category) VALUES ('blinkit:bread','blinkit','bread','Brown Bread','quick','bakery')",
    )
    .run();
});

function post(url: string, body: unknown, headers: Record<string, string> = KEY) {
  return app.request(url, { method: "POST", headers, body: JSON.stringify(body) }, env);
}

async function json(res: Response) {
  return res.json() as Promise<any>;
}

describe("POST /api/alerts", () => {
  it("writes to the alerts table, not to a prefs blob", async () => {
    const res = await post("/api/alerts", {
      alerts: [
        { product_id: "blinkit:milk", kind: "period_low", price: 28, sent_at: 1000 },
        { product_id: "blinkit:bread", kind: "threshold", price: 45, sent_at: 2000 },
      ],
    });
    expect(res.status).toBe(200);
    expect((await json(res)).recorded).toBe(2);

    const row = await shim
      .prepare("SELECT COUNT(*) AS n FROM alerts")
      .first<{ n: number }>();
    expect(row?.n).toBe(2);
  });

  it("accepts a single alert object as well as a list", async () => {
    const res = await post("/api/alerts", {
      product_id: "blinkit:milk",
      kind: "threshold",
      price: 20,
    });
    expect(res.status).toBe(200);
    expect((await json(res)).recorded).toBe(1);
  });

  it("is idempotent: a retried POST does not duplicate the dedupe log", async () => {
    const body = {
      alerts: [{ product_id: "blinkit:milk", kind: "period_low", price: 28, sent_at: 1000 }],
    };
    await post("/api/alerts", body);
    await post("/api/alerts", body);
    const row = await shim.prepare("SELECT COUNT(*) AS n FROM alerts").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("rejects an unknown kind rather than storing something the app cannot decode", async () => {
    const res = await post("/api/alerts", {
      product_id: "blinkit:milk",
      kind: "vibes",
      price: 28,
    });
    expect(res.status).toBe(400);
  });

  it("requires the ingest key", async () => {
    const res = await post(
      "/api/alerts",
      { product_id: "blinkit:milk", kind: "threshold", price: 1 },
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/alerts", () => {
  beforeEach(async () => {
    await post("/api/alerts", {
      alerts: [
        { product_id: "blinkit:milk", kind: "period_low", price: 28, sent_at: 1000 },
        { product_id: "blinkit:milk", kind: "threshold", price: 26, sent_at: 3000 },
        { product_id: "blinkit:bread", kind: "threshold", price: 45, sent_at: 2000 },
      ],
    });
  });

  it("reads the dedupe log back, newest first", async () => {
    const body = await json(await app.request("/api/alerts", {}, env));
    expect(body.count).toBe(3);
    expect(body.alerts.map((a: any) => a.sent_at)).toEqual([3000, 2000, 1000]);
    // The tuple the collector dedupes on is fully present.
    expect(body.alerts[0]).toMatchObject({
      product_id: "blinkit:milk",
      kind: "threshold",
      price: 26,
    });
  });

  it("filters by since, product_id and kind", async () => {
    const since = await json(await app.request("/api/alerts?since=2000", {}, env));
    expect(since.count).toBe(2);

    const byProduct = await json(
      await app.request("/api/alerts?product_id=blinkit:bread", {}, env),
    );
    expect(byProduct.count).toBe(1);

    const byKind = await json(await app.request("/api/alerts?kind=period_low", {}, env));
    expect(byKind.count).toBe(1);

    const both = await json(
      await app.request("/api/alerts?product_id=blinkit:milk&kind=threshold", {}, env),
    );
    expect(both.count).toBe(1);
  });
});

describe("/api/alerts/pending", () => {
  const held = (scheduledFor: number, price = 28) => ({
    product_id: "blinkit:milk",
    kind: "period_low",
    price,
    scheduled_for: scheduledFor,
    payload: { message: "Lowest in 12 days", category: "dairy", lowest_in_days: 12 },
  });

  it("survives a process exit: what is written is what is read back", async () => {
    const res = await post("/api/alerts/pending", { action: "replace", alerts: [held(5000)] });
    expect(res.status).toBe(200);

    const body = await json(await app.request("/api/alerts/pending", {}, env));
    expect(body.count).toBe(1);
    expect(body.pending[0].scheduled_for).toBe(5000);
    // The whole engine Alert is preserved, so the morning delivery sends the
    // real message rather than a reconstructed guess.
    expect(body.pending[0].payload.message).toBe("Lowest in 12 days");
    expect(body.pending[0].payload.lowest_in_days).toBe(12);
  });

  it("replace is a true replace — a delivered alert leaves the queue", async () => {
    await post("/api/alerts/pending", {
      action: "replace",
      alerts: [held(5000, 28), held(6000, 26)],
    });
    await post("/api/alerts/pending", { action: "replace", alerts: [held(6000, 26)] });

    const body = await json(await app.request("/api/alerts/pending", {}, env));
    expect(body.count).toBe(1);
    expect(body.pending[0].price).toBe(26);
  });

  it("append keeps what is already held and never duplicates the same hold", async () => {
    await post("/api/alerts/pending", { action: "replace", alerts: [held(5000, 28)] });
    await post("/api/alerts/pending", { action: "append", alerts: [held(5000, 28), held(6000, 26)] });

    const body = await json(await app.request("/api/alerts/pending", {}, env));
    expect(body.count).toBe(2);
  });

  it("due_by selects only what is ready to deliver", async () => {
    await post("/api/alerts/pending", {
      action: "replace",
      alerts: [held(5000, 28), held(9000, 26)],
    });
    const body = await json(await app.request("/api/alerts/pending?due_by=5000", {}, env));
    expect(body.count).toBe(1);
    expect(body.pending[0].price).toBe(28);
  });

  it("rejects a held alert with no release time instead of dropping it silently", async () => {
    const res = await post("/api/alerts/pending", {
      action: "replace",
      alerts: [{ product_id: "blinkit:milk", kind: "period_low", price: 28 }],
    });
    expect(res.status).toBe(400);
  });

  it("requires the ingest key to write", async () => {
    const res = await post(
      "/api/alerts/pending",
      { action: "replace", alerts: [] },
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/register-device", () => {
  it("hands the sweep the token the app actually registered", async () => {
    await post("/api/register-device", { token: "tok-old", platform: "android" });
    await new Promise((r) => setTimeout(r, 2));
    await post("/api/register-device", { token: "tok-new", platform: "android" });

    const res = await app.request(
      "/api/register-device",
      { headers: { "X-Ingest-Key": "test-secret" } },
      env,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.device.token).toBe("tok-new");
    expect(body.device.platform).toBe("android");
  });

  it("treats 'no device registered yet' as a normal 200, not a 404", async () => {
    const res = await app.request(
      "/api/register-device",
      { headers: { "X-Ingest-Key": "test-secret" } },
      env,
    );
    expect(res.status).toBe(200);
    expect((await json(res)).device).toBeNull();
  });

  it("does not hand an FCM token to an unauthenticated caller", async () => {
    await post("/api/register-device", { token: "tok", platform: "android" });
    const res = await app.request("/api/register-device", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("GET/POST /api/categories", () => {
  it("carries mode as data, so no caller has to read it off the slug", async () => {
    const all = await json(await app.request("/api/categories", {}, env));
    const bySlug = new Map(all.categories.map((c: any) => [c.slug, c.mode]));
    expect(bySlug.get("dairy")).toBe("quick");
    expect(bySlug.get("fashion-tops")).toBe("fashion");

    const fashion = await json(await app.request("/api/categories?mode=fashion", {}, env));
    expect(fashion.categories.every((c: any) => c.mode === "fashion")).toBe(true);
    expect(fashion.categories.length).toBeGreaterThan(0);
  });

  it("covers every slug seeded into prefs.enabled_categories", async () => {
    const prefs = await json(await app.request("/api/prefs", {}, env));
    const all = await json(await app.request("/api/categories", {}, env));
    const known = new Set(all.categories.map((c: any) => c.slug));
    for (const slug of prefs.prefs.enabled_categories) {
      expect(known.has(slug), `${slug} must be in the category catalog`).toBe(true);
    }
  });

  it("lets a new category be added without a naming convention", async () => {
    // A quick-commerce category whose name starts with "fashion" — the old
    // prefix heuristic would have swept it in the wrong mode.
    const res = await post(
      "/api/categories",
      { categories: [{ slug: "fashionable-snacks", label: "Fashionable Snacks", mode: "quick" }] },
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(200);
    const quick = await json(await app.request("/api/categories?mode=quick", {}, env));
    expect(quick.categories.map((c: any) => c.slug)).toContain("fashionable-snacks");
  });

  it("rejects a category with no mode rather than inventing one", async () => {
    const res = await post(
      "/api/categories",
      { categories: [{ slug: "mystery", label: "Mystery" }] },
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(400);
  });
});
