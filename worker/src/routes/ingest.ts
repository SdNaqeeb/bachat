// POST /api/ingest [X-Ingest-Key] -> bulk upsert from GitHub Actions collectors.
// See src/lib/ingest.ts for the idempotent, batched upsert logic.

import { Hono } from "hono";
import type { Env } from "../types";
import { ApiError } from "../types";
import { runIngest, validateIngestBody } from "../lib/ingest";

export const ingest = new Hono<{ Bindings: Env }>();

ingest.post("/", async (c) => {
  const key = c.req.header("X-Ingest-Key");
  if (!key || key !== c.env.INGEST_KEY) {
    throw new ApiError(401, "unauthorized", "missing or invalid X-Ingest-Key");
  }

  const raw = await c.req.json().catch(() => null);
  if (raw == null) throw new ApiError(400, "bad_request", "body must be JSON");

  let body;
  try {
    body = validateIngestBody(raw);
  } catch (e) {
    throw new ApiError(400, "bad_request", e instanceof Error ? e.message : "invalid body");
  }

  const result = await runIngest(c.env, body);

  return c.json({ ok: true, ...result });
});
