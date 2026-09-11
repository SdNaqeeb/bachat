// Ingest: bulk upsert from a GitHub Actions collector sweep.
//
// Idempotency: every statement here is safe to re-run with identical input.
//   - products:    upsert keyed on (retailer_id, ext_id) — id is derived
//                  deterministically as `${retailer_id}:${ext_id}`.
//   - prices:      INSERT OR IGNORE against a UNIQUE(product_id, captured_at)
//                  index — re-posting the same sweep appends nothing twice.
//   - price_daily: upsert that takes MIN/MAX with the existing row, so
//                  applying the same day's numbers twice is a no-op.
//
// Batching: statements are grouped into chunks and sent via env.DB.batch(),
// which D1 executes as a single round trip per chunk (not per-row), keeping
// us well inside the 100k writes/day budget (spec section 2) and away from
// the Worker's subrequest ceiling (D1 binding calls are not subrequests).

import { dayString } from "./dates";
import type { Env, Mode } from "../types";

export type IngestOffer = {
  ext_id: string;
  name: string;
  brand?: string | null;
  size?: string | null;
  pack?: string | null;
  image_url?: string | null;
  url?: string | null;
  category?: string | null;
  mode: Mode;
  price: number;
  mrp?: number | null;
  in_stock: boolean;
};

export type IngestBody = {
  retailer_id: string;
  captured_at: number;
  offers: IngestOffer[];
};

export type IngestResult = {
  products_upserted: number;
  price_rows_attempted: number;
  rollups_upserted: number;
};

const CHUNK_SIZE = 100; // offers per D1 batch call (x3 statements each)

export function validateIngestBody(body: unknown): IngestBody {
  if (!body || typeof body !== "object") throw new Error("body must be an object");
  const b = body as Record<string, unknown>;
  if (typeof b.retailer_id !== "string" || !b.retailer_id) {
    throw new Error("retailer_id is required");
  }
  if (typeof b.captured_at !== "number" || !Number.isFinite(b.captured_at)) {
    throw new Error("captured_at (epoch ms) is required");
  }
  if (!Array.isArray(b.offers)) throw new Error("offers must be an array");
  for (const [i, o] of (b.offers as unknown[]).entries()) {
    if (!o || typeof o !== "object") throw new Error(`offers[${i}] must be an object`);
    const offer = o as Record<string, unknown>;
    if (typeof offer.ext_id !== "string" || !offer.ext_id) {
      throw new Error(`offers[${i}].ext_id is required`);
    }
    if (typeof offer.name !== "string" || !offer.name) {
      throw new Error(`offers[${i}].name is required`);
    }
    if (typeof offer.price !== "number" || !Number.isFinite(offer.price)) {
      throw new Error(`offers[${i}].price must be a number`);
    }
    if (offer.mode !== "quick" && offer.mode !== "fashion") {
      throw new Error(`offers[${i}].mode must be 'quick' or 'fashion'`);
    }
  }
  return b as unknown as IngestBody;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function runIngest(env: Env, body: IngestBody): Promise<IngestResult> {
  const day = dayString(body.captured_at);
  const batches = chunk(body.offers, CHUNK_SIZE);

  let productsUpserted = 0;
  let priceRows = 0;
  let rollups = 0;

  for (const batch of batches) {
    const statements: D1PreparedStatement[] = [];

    for (const offer of batch) {
      const productId = `${body.retailer_id}:${offer.ext_id}`;

      statements.push(
        env.DB.prepare(
          `INSERT INTO products
             (id, retailer_id, ext_id, name, brand, size, pack, image_url, url, category, mode)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(retailer_id, ext_id) DO UPDATE SET
             name=excluded.name, brand=excluded.brand, size=excluded.size,
             pack=excluded.pack, image_url=excluded.image_url, url=excluded.url,
             category=excluded.category, mode=excluded.mode`,
        ).bind(
          productId,
          body.retailer_id,
          offer.ext_id,
          offer.name,
          offer.brand ?? null,
          offer.size ?? null,
          offer.pack ?? null,
          offer.image_url ?? null,
          offer.url ?? null,
          offer.category ?? null,
          offer.mode,
        ),
      );

      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO prices (product_id, price, mrp, in_stock, captured_at)
           VALUES (?,?,?,?,?)`,
        ).bind(productId, offer.price, offer.mrp ?? null, offer.in_stock ? 1 : 0, body.captured_at),
      );

      statements.push(
        env.DB.prepare(
          `INSERT INTO price_daily (product_id, day, min_price, max_price)
           VALUES (?,?,?,?)
           ON CONFLICT(product_id, day) DO UPDATE SET
             min_price = MIN(min_price, excluded.min_price),
             max_price = MAX(max_price, excluded.max_price)`,
        ).bind(productId, day, offer.price, offer.price),
      );

      productsUpserted += 1;
      priceRows += 1;
      rollups += 1;
    }

    await env.DB.batch(statements);
  }

  return { products_upserted: productsUpserted, price_rows_attempted: priceRows, rollups_upserted: rollups };
}
