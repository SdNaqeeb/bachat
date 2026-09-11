// POST /api/register-device -> store/refresh an FCM token for push delivery.

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
