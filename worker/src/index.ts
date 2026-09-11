// Bachat Worker — the only REST contract the mobile app sees.
// Never scrapes, never calls a retailer; only reads and writes D1.

import { Hono } from "hono";
import type { Env } from "./types";
import { ApiError } from "./types";

import { health } from "./routes/health";
import { basket } from "./routes/basket";
import { deals } from "./routes/deals";
import { compare } from "./routes/compare";
import { history } from "./routes/history";
import { facets } from "./routes/facets";
import { prefs } from "./routes/prefs";
import { registerDevice } from "./routes/register-device";
import { ingest } from "./routes/ingest";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(err.toBody(), err.status as 400 | 401 | 404 | 409 | 500);
  }
  console.error(err);
  return c.json({ error: { code: "internal_error", message: "unexpected error" } }, 500);
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "no such route" } }, 404));

app.route("/api/health", health);
app.route("/api/basket", basket);
app.route("/api/deals", deals);
app.route("/api/compare", compare);
app.route("/api/history", history);
app.route("/api/facets", facets);
app.route("/api/prefs", prefs);
app.route("/api/register-device", registerDevice);
app.route("/api/ingest", ingest);

export default app;
