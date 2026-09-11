// POST /api/register-device -> store/refresh an FCM token for push delivery.
// GET  /api/register-device [X-Ingest-Key] -> read the registered token back.
//
// The GET exists so the sweep pushes to the token the APP actually
// registered, instead of a token pasted into an Actions secret that goes
// stale the moment Firebase rotates it. It is key-protected because an FCM
// registration token is a credential; every other read route is open.
//
// "No device registered yet" is a NORMAL state, not an error: a fresh
// install has no token and the sweep must still run and ingest prices. So
// this answers 200 with `device: null` rather than 404.

import { Hono } from "hono";
import type { Env } from "../types";
import { ApiError } from "../types";

export const registerDevice = new Hono<{ Bindings: Env }>();

type Body = { token?: string; platform?: string };

registerDevice.post("/", async (c) => {
  const body = await c.req.json<Body>().catch(() => null);
  if (!body || typeof body.token !== "string" || !body.token) {
    throw new ApiError(400, "bad_request", "token is required");
  }

  await c.env.DB.prepare(
    `INSERT INTO devices (token, platform, registered_at) VALUES (?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, registered_at = excluded.registered_at`,
  )
    .bind(body.token, body.platform ?? null, Date.now())
    .run();

  return c.json({ ok: true });
});

registerDevice.get("/", async (c) => {
  const key = c.req.header("X-Ingest-Key");
  if (!key || key !== c.env.INGEST_KEY) {
    throw new ApiError(401, "unauthorized", "missing or invalid X-Ingest-Key");
  }

  // Single user, one phone (spec section 2) — but re-installs leave old rows
  // behind, so the most recently registered token is the live one.
  const row = await c.env.DB.prepare(
    "SELECT token, platform, registered_at FROM devices ORDER BY registered_at DESC LIMIT 1",
  ).first<{ token: string; platform: string | null; registered_at: number }>();

  return c.json({ device: row ?? null });
});
