# Bachat Worker

Cloudflare Worker + D1 backend for Bachat. This is the **only** REST contract
the mobile app talks to, and it owns the price database. It never scrapes and
never calls a retailer — it only reads and writes D1.

Everything below assumes you have never used Cloudflare before. **No credit
card is required** for anything in this guide — D1 and Workers both have a
free tier that is more than enough for a single-user app.

## 0. Prerequisites

- Node.js 18+ (check with `node -v`)
- A free Cloudflare account: https://dash.cloudflare.com/sign-up (email +
  password only, no card)

## 1. Install dependencies

```bash
cd worker
npm install
```

## 2. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser tab to authorize the CLI. Approve it, then return to
the terminal.

## 3. Create the D1 database

```bash
npx wrangler d1 create bachat
```

This prints something like:

```toml
[[d1_databases]]
binding = "DB"
database_name = "bachat"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` value and paste it into `worker/wrangler.toml`,
replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

## 4. Apply the schema

Apply it twice — once to your local dev database (used by `wrangler dev`),
once to the real remote database (used once you deploy):

```bash
npm run db:apply:local
npm run db:apply:remote
```

Both commands run `worker/schema.sql`, which creates every table and index
and seeds the five v1 retailers (Blinkit, BigBasket, Myntra, Amazon.in,
Flipkart) plus sensible default prefs (delivery fees, threshold, quiet
hours). Re-running the schema is safe — every statement is `IF NOT EXISTS`
or `INSERT OR IGNORE`.

## 5. Set the ingest secret

The collector (GitHub Actions) authenticates to `POST /api/ingest` with a
shared secret header, `X-Ingest-Key`. Pick any long random string and set it
as a Worker secret:

```bash
npx wrangler secret put INGEST_KEY
```

It will prompt you to paste the value. Put the **same value** into your
GitHub Actions repo secrets (see `collectors/`'s README) so the collector can
authenticate.

## 6. Run it locally

```bash
npm run dev
```

This starts a local Worker at `http://127.0.0.1:8787` backed by your local
D1 database. Try:

```bash
curl http://127.0.0.1:8787/api/health
```

## 7. Deploy

```bash
npm run deploy
```

Wrangler prints your public URL, something like:

```
https://bachat-worker.<your-subdomain>.workers.dev
```

That URL is what you put into the mobile app's config as the API base URL.

## 8. Run the tests

```bash
npm test
```

This runs the full suite (basket ranking, the 30-day-low honesty rule,
ingest idempotency, and route-level tests) against a real SQLite engine via
`test/d1-shim.ts` — see the comment at the top of that file for why a plain
`node:sqlite`-backed shim is used instead of `@cloudflare/vitest-pool-workers`
directly (a Windows-only path-with-spaces bug in workerd's module loader). A
parallel `vitest.config.workers.ts` is included for CI on Linux if you want
the official Cloudflare test harness.

## Project layout

```
worker/
├── schema.sql              D1 schema + seed data (retailers, default prefs)
├── wrangler.toml            Worker config (fill in your D1 database_id)
├── src/
│   ├── index.ts              Hono app, mounts every route
│   ├── types.ts               Env, ApiError, shared types
│   ├── lib/
│   │   ├── basket.ts           Basket ranking engine (spec section 8)
│   │   ├── history.ts          30-day-low honesty rule (spec section 7)
│   │   ├── ingest.ts           Idempotent, batched upsert for POST /api/ingest
│   │   ├── db.ts                Small shared D1 query helpers
│   │   └── dates.ts             Day-string / age helpers
│   └── routes/                One file per endpoint
└── test/                     Unit + route-level tests
```

## Free-tier budget (spec section 2)

| Resource | Limit | This project's usage |
| --- | --- | --- |
| D1 writes | 100k/day | ~15k/day (3-4 sweeps × ~2000 products) |
| D1 storage | 5 GB | price history pruned to 90 days |
| Worker requests | 100k/day | read-only API, single user |
| Worker subrequests | 50/request | 0 — the Worker only touches its D1 binding |

`prices` is pruned to 90 days by the collector's daily rollup job (not by the
Worker) to stay well under the D1 storage/row limits.

## Notes for the mobile app

- Every price-bearing response carries `captured_at` (epoch ms) so the app
  can show staleness ("prices are 4 hours old").
- Any response with a "period low" claim also carries `days_observed` — the
  real number of days of history behind the claim. Never trust a "30-day
  low" claim without checking this field; the API itself never overstates it
  (see `src/lib/history.ts`).
- Errors are always `{ "error": { "code": string, "message": string } }`
  with a matching HTTP status (400/401/404/500).
