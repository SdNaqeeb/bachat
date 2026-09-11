// The alert log and the quiet-hours hold queue (spec section 7).
//
//   POST /api/alerts                 [X-Ingest-Key]  record sent alert(s)
//   GET  /api/alerts?since=&product_id=&kind=&limit=  read the log back
//   GET  /api/alerts/pending?due_by=                  the held queue
//   POST /api/alerts/pending         [X-Ingest-Key]   replace/append the queue
//
// Why these exist: the sweep runs as a fresh GitHub Actions process every
// time, so BOTH its dedupe log ("the same product at the same price never
// notifies twice") and its held-alert queue ("quiet-hours alerts are held
// until morning, never dropped") must be durable server-side. They used to
// be JSON blobs stuffed into the generic `prefs` key/value surface, which
// left the schema's `alerts` table permanently empty and the dedupe state
// unqueryable. This is the real thing.
//
// Writes require the collector's X-Ingest-Key because they are the sweep's
// own bookkeeping and a bad write here silences real notifications. Reads
// are open, like every other app-facing route.

import { Hono } from "hono";
import type { Env } from "../types";
import { ApiError } from "../types";

export const alerts = new Hono<{ Bindings: Env }>();

const DEFAULT_LIMIT = 2000; // "a handful of alerts per day" (spec section 2)
const MAX_LIMIT = 5000;
const KINDS = new Set(["threshold", "period_low"]);

type AlertInput = {
  id?: string;
  product_id?: unknown;
  kind?: unknown;
  price?: unknown;
  sent_at?: unknown;
};

function requireIngestKey(c: { req: { header(name: string): string | undefined }; env: Env }): void {
  const key = c.req.header("X-Ingest-Key");
  if (!key || key !== c.env.INGEST_KEY) {
    throw new ApiError(401, "unauthorized", "missing or invalid X-Ingest-Key");
  }
}

/** Accepts either a single alert object or `{ alerts: [...] }`. */
function alertsFromBody(body: unknown): AlertInput[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "bad_request", "body must be an alert object or { alerts: [...] }");
  }
  const b = body as Record<string, unknown>;
  const list = Array.isArray(b.alerts) ? (b.alerts as AlertInput[]) : [b as AlertInput];
  if (list.length === 0) throw new ApiError(400, "bad_request", "no alerts given");
  return list;
}

function validateAlert(a: AlertInput, i: number, now: number) {
  if (typeof a.product_id !== "string" || !a.product_id) {
    throw new ApiError(400, "bad_request", `alerts[${i}].product_id is required`);
  }
  if (typeof a.kind !== "string" || !KINDS.has(a.kind)) {
    throw new ApiError(400, "bad_request", `alerts[${i}].kind must be 'threshold' or 'period_low'`);
  }
  if (typeof a.price !== "number" || !Number.isFinite(a.price)) {
    throw new ApiError(400, "bad_request", `alerts[${i}].price must be a number`);
  }
  const sentAt =
    typeof a.sent_at === "number" && Number.isFinite(a.sent_at) ? Math.floor(a.sent_at) : now;
  // A deterministic default id makes a retried POST idempotent instead of
  // duplicating the log entry the dedupe check reads back.
  const id =
    typeof a.id === "string" && a.id ? a.id : `${a.product_id}|${a.kind}|${a.price}|${sentAt}`;
  return { id, product_id: a.product_id, kind: a.kind, price: a.price, sent_at: sentAt };
}

alerts.post("/", async (c) => {
  requireIngestKey(c);
  const now = Date.now();
  const raw = await c.req.json().catch(() => null);
  const rows = alertsFromBody(raw).map((a, i) => validateAlert(a, i, now));

  await c.env.DB.batch(
    rows.map((r) =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO alerts (id, product_id, kind, price, sent_at)
         VALUES (?,?,?,?,?)`,
      ).bind(r.id, r.product_id, r.kind, r.price, r.sent_at),
    ),
  );

  return c.json({ ok: true, recorded: rows.length, ids: rows.map((r) => r.id) });
});

alerts.get("/", async (c) => {
  const since = parseInt(c.req.query("since") ?? "", 10);
  const productId = c.req.query("product_id");
  const kind = c.req.query("kind");
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(c.req.query("limit") ?? "", 10) || DEFAULT_LIMIT),
  );

  const where: string[] = [];
  const params: unknown[] = [];
  if (Number.isFinite(since)) {
    where.push("sent_at >= ?");
    params.push(since);
  }
  if (productId) {
    where.push("product_id = ?");
    params.push(productId);
  }
  if (kind) {
    if (!KINDS.has(kind)) {
      throw new ApiError(400, "bad_request", "kind must be 'threshold' or 'period_low'");
    }
    where.push("kind = ?");
    params.push(kind);
  }
  params.push(limit);

  const { results } = await c.env.DB.prepare(
    `SELECT id, product_id, kind, price, sent_at FROM alerts
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY sent_at DESC LIMIT ?`,
  )
    .bind(...params)
    .all<{ id: string; product_id: string; kind: string; price: number; sent_at: number }>();

  const items = results ?? [];
  return c.json({
    alerts: items,
    count: items.length,
    since: Number.isFinite(since) ? since : null,
  });
});

// --- held queue -----------------------------------------------------------

type PendingInput = {
  id?: string;
  product_id?: unknown;
  kind?: unknown;
  price?: unknown;
  scheduled_for?: unknown; // epoch ms
  payload?: unknown; // the full engine Alert, stored verbatim
};

alerts.get("/pending", async (c) => {
  const dueBy = parseInt(c.req.query("due_by") ?? "", 10);
  const clause = Number.isFinite(dueBy) ? "WHERE scheduled_for <= ?" : "";
  const stmt = c.env.DB.prepare(
    `SELECT id, product_id, kind, price, scheduled_for, payload, created_at
     FROM pending_alerts ${clause} ORDER BY scheduled_for ASC`,
  );
  const { results } = await (Number.isFinite(dueBy) ? stmt.bind(dueBy) : stmt).all<{
    id: string;
    product_id: string;
    kind: string;
    price: number;
    scheduled_for: number;
    payload: string;
    created_at: number;
  }>();

  const items = (results ?? []).map((r) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(r.payload);
    } catch {
      payload = null;
    }
    return {
      id: r.id,
      product_id: r.product_id,
      kind: r.kind,
      price: r.price,
      scheduled_for: r.scheduled_for,
      created_at: r.created_at,
      payload,
    };
  });

  return c.json({ pending: items, count: items.length });
});

alerts.post("/pending", async (c) => {
  requireIngestKey(c);
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "bad_request", "body must be { action, alerts: [...] }");
  }
  const body = raw as { action?: unknown; alerts?: unknown };
  const action = body.action === undefined ? "replace" : body.action;
  if (action !== "replace" && action !== "append") {
    throw new ApiError(400, "bad_request", "action must be 'replace' or 'append'");
  }
  if (!Array.isArray(body.alerts)) {
    throw new ApiError(400, "bad_request", "alerts must be an array");
  }

  const now = Date.now();
  const rows = (body.alerts as PendingInput[]).map((a, i) => {
    if (typeof a?.product_id !== "string" || !a.product_id) {
      throw new ApiError(400, "bad_request", `alerts[${i}].product_id is required`);
    }
    if (typeof a.kind !== "string" || !KINDS.has(a.kind)) {
      throw new ApiError(400, "bad_request", `alerts[${i}].kind must be 'threshold' or 'period_low'`);
    }
    if (typeof a.price !== "number" || !Number.isFinite(a.price)) {
      throw new ApiError(400, "bad_request", `alerts[${i}].price must be a number`);
    }
    if (typeof a.scheduled_for !== "number" || !Number.isFinite(a.scheduled_for)) {
      throw new ApiError(400, "bad_request", `alerts[${i}].scheduled_for (epoch ms) is required`);
    }
    const scheduledFor = Math.floor(a.scheduled_for);
    // Same (product, kind, price, release time) collapses to one row, so a
    // sweep that re-holds an alert it already holds never grows the queue.
    const id =
      typeof a.id === "string" && a.id
        ? a.id
        : `${a.product_id}|${a.kind}|${a.price}|${scheduledFor}`;
    return {
      id,
      product_id: a.product_id,
      kind: a.kind,
      price: a.price,
      scheduled_for: scheduledFor,
      payload: JSON.stringify(a.payload ?? a),
      created_at: now,
    };
  });

  const statements: D1PreparedStatement[] = [];
  if (action === "replace") {
    // Replace is the sweep's normal write: it has just re-derived the entire
    // held set (old pending + newly held - everything it delivered).
    statements.push(c.env.DB.prepare("DELETE FROM pending_alerts"));
  }
  for (const r of rows) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO pending_alerts
           (id, product_id, kind, price, scheduled_for, payload, created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           scheduled_for = excluded.scheduled_for,
           payload       = excluded.payload`,
      ).bind(
        r.id,
        r.product_id,
        r.kind,
        r.price,
        r.scheduled_for,
        r.payload,
        r.created_at,
      ),
    );
  }
  if (statements.length > 0) await c.env.DB.batch(statements);

  return c.json({ ok: true, action, pending_count: rows.length });
});
