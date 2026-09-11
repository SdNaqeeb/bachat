# Bachat — Design

> A personal price comparison app for Indian quick-commerce and fashion retail.
> One screen replaces opening five apps.

Status: approved 2026-09-12. Single user, zero recurring cost.

---

## 1. The problem

The user opens Blinkit, Zepto, Instamart, BigBasket and Amazon in sequence,
every day, comparing prices by hand before ordering groceries. The same chore
repeats weekly across Myntra, Ajio and Nykaa for clothes. The cost is time and
attention, not money.

The product is therefore **not** a deal-discovery feed. It is a *decision*
screen: given what you actually buy, which app should you order from right now.
Deal discovery is a secondary feature layered on top.

## 2. Non-negotiable constraints

| Constraint | Consequence |
| --- | --- |
| Zero recurring cost, no credit card | GitHub Actions + Cloudflare free tiers only |
| Notifications must arrive with the app closed | FCM high-priority; server runs without the phone |
| Single user, one phone | No auth, no accounts, no per-user fan-out |
| Free tiers are hard-enforced | Sweeps must be capped and budgeted |

### Verified free-tier headroom

| Service | Limit | Our usage |
| --- | --- | --- |
| Cloudflare D1 | 5 GB, 5M reads/day, **100k writes/day** | ~15k writes/day |
| Cloudflare Workers | 100k req/day, 50 subrequests, 10 ms CPU | read API only |
| GitHub Actions | 2000 min/mo (private) | ~1400 min/mo |
| FCM push | free | a handful per day |

The 50-subrequest and 10 ms CPU caps on Workers are precisely why collectors run
in GitHub Actions and not in a Worker. This split is the central architectural
decision.

## 3. Retailer feasibility — measured, not assumed

All results below come from a real HTTP client with a browser User-Agent on
2026-09-11. Two earlier research passes reported different (wrong) results for
Blinkit and Amazon; these measured figures supersede them.

| Retailer | Mode | Result | Status |
| --- | --- | --- | --- |
| **Blinkit** | quick | `/cn/<slug>/cid/<c>/<s>` → 200, **727 price entries**, exposes `lat`/`lon`/`merchant_id` | ship v1 |
| **BigBasket** | quick | `/cl/<slug>/` → 200, **350 products** in `__NEXT_DATA__`, `mrp`/`sp`/`brand` | ship v1 |
| **Myntra** | fashion | `__myx` JSON; filters server-side via `?f=Brand:Nike::size_facet:M` | ship v1 |
| **Amazon.in** | fashion | `/s?k=` → 200, 72 ASINs with prices, no captcha | ship v1 |
| **Flipkart** | fashion | 1st request 200 (886 KB), subsequent throttled to 787 b | ship v1, slow pacing |
| Zepto | quick | 202, zero bytes — AWS WAF | deferred |
| Swiggy Instamart | quick | session-cookie gated, no simple JSON endpoint | deferred |
| Ajio | fashion | 403 Akamai, including internal Hybris API | blocked |
| Nykaa Fashion | fashion | 403 Akamai | blocked |
| Amazon Now / Flipkart Minutes | quick | not yet probed | deferred |

Deferred retailers are deferred, not abandoned: the adapter interface (§6) is
uniform, so each is one new file. Zepto and Instamart need browser automation,
which does not fit the Actions minute budget today. Ajio and Nykaa need rotating
residential proxies, which cost money and so violate §2.

**Myntra's server-side size and brand facets are why the fashion filter
requirement is cheap.** Filters push to the retailer rather than being applied
after collection.

## 4. Architecture

```
GitHub Actions (Python, cron)             Cloudflare
┌────────────────────────────┐           ┌───────────────────┐
│ adapters/  blinkit.py      │           │ Worker (REST)     │◄─── phone
│            bigbasket.py    │──ingest──►│ D1 (price history)│
│            myntra.py       │           └───────────────────┘
│            amazon.py       │
│            flipkart.py     │
│ engine/    deal detection  │───FCM high-priority push────► phone (app closed)
└────────────────────────────┘
```

Three deployables, each independently testable:

1. **collectors/** — Python. Fetch, parse, normalise, POST to the Worker. Knows
   nothing about storage or the app.
2. **worker/** — TypeScript on Cloudflare. Owns the D1 schema and the only REST
   contract the app sees. Never scrapes.
3. **mobile/** — Expo app. Never scrapes, never talks to a retailer. Reads the
   Worker API only.

### Repository layout

```
Bachat/
├── collectors/
│   ├── adapters/          one module per retailer
│   ├── core/              Offer/Location types, http client, rate limiter
│   ├── engine/            deal detection, 30-day low, alert dedupe
│   ├── push/              FCM HTTP v1 sender
│   └── tests/             fixture-driven parser tests
├── worker/
│   ├── src/               routes, D1 queries
│   ├── schema.sql
│   └── wrangler.toml
├── mobile/                Expo app (IntelliVault conventions)
└── .github/workflows/     sweep schedules + keepalive
```

## 5. Data model (D1)

```sql
retailers(id TEXT PK, name TEXT, mode TEXT, deeplink_tpl TEXT)

products(id TEXT PK, retailer_id TEXT, ext_id TEXT, name TEXT, brand TEXT,
         size TEXT, pack TEXT, image_url TEXT, url TEXT, category TEXT,
         mode TEXT, UNIQUE(retailer_id, ext_id))

-- append-only observations
prices(id INTEGER PK AUTOINCREMENT, product_id TEXT, price REAL, mrp REAL,
       in_stock INTEGER, captured_at INTEGER)

-- daily rollup; the 30-day low reads this, never the raw table
price_daily(product_id TEXT, day TEXT, min_price REAL, max_price REAL,
            PRIMARY KEY(product_id, day))

basket_items(id TEXT PK, label TEXT, qty INTEGER, mode TEXT, category TEXT)
matches(basket_item_id TEXT, product_id TEXT, confidence REAL)

saved_searches(id TEXT PK, mode TEXT, query TEXT, brands TEXT, sizes TEXT,
               max_price REAL)

prefs(key TEXT PK, value TEXT)
alerts(id TEXT PK, product_id TEXT, kind TEXT, price REAL, sent_at INTEGER)
```

`prices` is append-only and pruned to 90 days. `price_daily` is written by the
same sweep, keeping the 30-day-low query O(30) rows per product rather than
O(sweeps).

`matches` is the bridge that makes basket comparison possible: one
user-meaningful item ("Amul Taaza 500 ml") maps to one product per retailer.

### Write budget

Five retailers × ~400 products × 3 sweeps/day ≈ 6k price rows/day, plus
rollups. Comfortably inside D1's 100k writes/day.

## 6. Collector contract

Every adapter implements one interface. This is what makes deferred retailers
cheap to add later.

```python
@dataclass(frozen=True)
class Offer:
    ext_id: str
    name: str
    price: float
    mrp: float | None
    in_stock: bool
    url: str
    category: str
    brand: str | None = None
    size: str | None = None
    image_url: str | None = None

class Adapter(Protocol):
    id: str                      # 'blinkit'
    mode: Literal['quick', 'fashion']
    def sweep(self, category: Category, loc: Location) -> list[Offer]: ...
    def search(self, q: str, f: Filters, loc: Location) -> list[Offer]: ...
```

Rules every adapter obeys:

- **Parse fixtures, not the network, in tests.** Each adapter ships a saved
  HTML/JSON fixture so parser tests run offline and in CI. When a retailer
  changes its markup, one fixture refresh localises the break.
- **Rate limit per host.** Flipkart throttles after a single request; the shared
  client enforces a per-retailer delay and exponential backoff.
- **Never raise past the boundary.** A failing adapter logs, returns `[]`, and
  the sweep continues. One broken retailer must not cost the others' data.
- **No browser automation.** If a retailer needs it, it is deferred, not bolted
  in — it would blow the Actions minute budget.

### Location

Quick-commerce prices are dark-store-specific. Blinkit takes `lat`/`lon` and
returns a `merchant_id`; BigBasket uses `_bb_pin_code` / `_bb_nhid` cookies.
Both are stored in `prefs` and injected per request. The exact
pincode-to-cookie handshake for BigBasket is the one piece of reverse
engineering still outstanding — the collector task must resolve it and record
what it finds.

## 7. Deal engine

Two independent alert triggers:

1. **Threshold** — `(mrp - price) / mrp >= user_threshold` (default 60%).
2. **Period low** — `price <= min(price_daily over trailing 30 days)`.

Honesty rule, and it is a hard requirement: the app knows only the history it
has collected. Until 30 days of data exist for a product, the alert and the UI
say **"lowest in N days"** with the real N. It must never claim a 30-day low it
cannot substantiate. This is stated explicitly because it is the single easiest
thing for an implementer to get wrong.

Alerts dedupe against the `alerts` table — the same product at the same price
never notifies twice. Quiet hours (default 23:00–08:00 IST) hold notifications
until morning rather than dropping them.

Notifications are filtered by the user's enabled categories *and* current mode,
so fashion alerts never arrive for someone who only enabled groceries.

## 8. The basket comparison

The feature that addresses the actual pain. Comparison is by **basket total, not
item price** — being cheapest on one item is irrelevant if the other six force a
second order and a second delivery fee.

```
Basket of 7 items
  Zepto      ₹612  7/7 in stock  + ₹25 delivery  = ₹637   ← cheapest
  Blinkit    ₹598  6/7 in stock  + ₹30 delivery  = ₹628   1 item missing
  BigBasket  ₹589  7/7           + ₹40, 2 hr     = ₹629   ← cheapest if you can wait
```

Ranking rules:

- Only fully-stocked retailers can win outright. A retailer missing items is
  shown with its gap stated, never silently ranked on a partial basket.
- Delivery and handling fees are per-retailer values in `prefs`, user-editable,
  because they vary by cart value and change often. They are **not** scraped.
- The winner card states the saving against the runner-up, not against the worst
  option — the honest comparison is the next-best real choice.

## 9. Mobile app

Expo SDK 57 / RN 0.86, matching IntelliVault's conventions: kebab-case files,
`type` over `interface`, named exports, `src/theme/tokens.ts` as the single
source of visual truth, `PressableScale` on every tappable surface,
provider-pattern hooks, one `createClient()` factory normalising failures into a
typed `ApiError`.

**Mode switch** in the header (Quick Commerce ⇄ Fashion), Swiggy-style. Mode is
global state: it selects which retailers, categories, feed and alerts apply.

| Screen | Purpose |
| --- | --- |
| Basket | Regulars priced across retailers; winner by total (§8) |
| Deals | Category sweep feed, filtered to enabled categories |
| Compare | Search one item across retailers; size/brand filters in fashion mode |
| Settings | Categories, threshold, location, quiet hours, fees, battery-opt setup |

Offline and stale states are first-class: the app is useless if it cannot say
"prices are 4 hours old" when a sweep has failed. Every price shown carries its
`captured_at` age.

Tapping a result deep-links into the retailer's own app to buy. Bachat never
handles carts, checkout, payment or credentials.

## 10. Notifications

FCM HTTP v1, sent directly from the collector job with a service-account key in
Actions secrets. This avoids the Expo push relay and its `projectId` dependency.

Requirements for delivery to a killed app:

- message `priority: high`
- notification channel `IMPORTANCE_HIGH`, one channel per category so the user
  can mute categories at OS level
- `POST_NOTIFICATIONS` runtime permission (Android 13+)

**Known limitation, surfaced in the UI rather than hidden:** Xiaomi/MIUI,
OnePlus, Samsung and Realme battery managers drop FCM wake broadcasts even when
Firebase reports delivery. No code fixes this. Onboarding includes a one-time
guided step to disable battery optimisation and enable autostart, and Settings
shows delivery health (last push received vs last push sent) so silent failure
is visible rather than mysterious.

## 11. Build and signing

Reuses IntelliVault's local Gradle pipeline — no EAS, no expiry, no cost.

Copied unchanged: `D:\toolchain\jdk-17*`, `D:\android-sdk`, the licence-hash
trick, the prebuild → re-inject signing → `gradlew :app:assembleRelease`
sequence, the `-p <dir>` gradlew invocation, ASCII-only PowerShell scripts.

New for Bachat: its own keystore and alias, package `ai.smartlearners.bachat`,
Gradle property prefix `BACHAT_UPLOAD_*`, output `build/Bachat-release.apk`.

`android/`, `credentials/` and `build/` stay gitignored. **The keystore is
irreplaceable** — losing it means never being able to update an installed APK.

## 12. Scheduling

| Job | Cadence | Budget |
| --- | --- | --- |
| Quick-commerce sweep | every 4 h, offset off the hour | ~6 min/run |
| Fashion sweep | 2×/day | ~8 min/run |
| Daily rollup + prune | 1×/day | ~1 min |
| Keepalive commit | weekly | trivial |

Cron is offset off the hour because GitHub delays and sometimes drops
on-the-hour scheduled jobs under load. The keepalive exists because scheduled
workflows auto-disable after 60 days of repository inactivity.

## 13. Testing

- **Adapters:** fixture-driven parser tests, offline, no network in CI.
- **Engine:** table-driven tests for threshold, period-low and the "N days"
  honesty rule, including the under-30-days case.
- **Basket ranking:** tests for partial stock, fee inclusion and ties.
- **Worker:** route tests against a local D1.
- **App:** the API client is an interface with one real implementation, so
  screens develop against a fixture client with no backend running.

A live smoke check against real retailers runs separately from CI and is allowed
to fail without breaking the build — retailer breakage is expected, and must be
visible rather than fatal.

## 14. Explicit non-goals

No checkout, cart or payment. No retailer credentials. No accounts or
multi-user support. No iOS build. No Play Store listing — the scraping would not
survive review, and this is a personal-use app installed by APK.

## 15. Known risks

| Risk | Mitigation |
| --- | --- |
| Retailer changes markup | Fixture tests localise the break to one adapter |
| Retailer blocks our requests | Per-host pacing; adapter fails soft |
| OEM kills notifications | Guided setup + visible delivery health (§10) |
| Actions minutes exhausted | Budgeted at ~70%; a public repo makes them unlimited |
| 30-day low claimed too early | "N days" honesty rule, tested (§7) |
| Keystore lost | Documented as irreplaceable; user must back it up |

Scraping these sites is contrary to the retailers' terms of service. This is a
single-user, low-volume, personal-use tool that reads publicly visible prices
and places no orders. The user has been told this plainly and accepted it.
