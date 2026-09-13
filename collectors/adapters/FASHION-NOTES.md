# Fashion adapters — measured notes

Everything here was measured with a real HTTP client and a desktop Chrome
User-Agent on **2026-09-12**, against the live sites, from a residential IP in
India. Where a measurement contradicts the design spec
(`docs/superpowers/specs/2026-09-12-bachat-design.md`) the measurement wins and
the discrepancy is called out.

Retailers covered: **Myntra**, **Amazon.in**, **Flipkart**.

---

## 1. Myntra — the good one

`GET https://www.myntra.com/men-tshirts` → **200, 1,418,320 bytes**.
No headless browser, no cookies, no auth, no XHR replay. One plain GET.

### What is actually in the page

The whole listing response is assigned to `window.__myx` inside an inline
`<script>`. Regex used: `window\.__myx\s*=\s*(\{.*?\});?\s*</script>`.

```
window.__myx
├── searchData
│   ├── pageTitle              "Men T-shirts"
│   ├── nextPaginationContext
│   └── results
│       ├── totalCount         409115
│       ├── products[]         32–50 per page  ← the offers
│       ├── plaProducts[]      sponsored ads   ← deliberately NOT parsed
│       ├── filters{}          the facets      ← see §1.3
│       └── appliedParams{}    read-back of what the server applied
└── countryCode
```

> **Spec correction (§3, §6).** The spec says "`searchData.results` holds the
> products". It does not — `searchData.results` is an object with ~45 keys and
> the products live at **`searchData.results.products`**. Trivial, but it would
> have cost someone an afternoon.

### 1.1 Product fields (real names, copied from a live payload)

| Offer field | Myntra path | Example |
| --- | --- | --- |
| `ext_id` | `productId` | `36674095` |
| `name` | `productName` (fallback `product`) | `Puma TRAIN ALL DAY Essentials ...` |
| `price` | `price` | `719` |
| `mrp` | `mrp` | `1499` |
| `brand` | `brand` | `Puma` |
| `category` | *(ours)* `Category.slug` | `tshirts` |
| `url` | `https://www.myntra.com/` + `landingPageUrl` | `.../36674095/buy` |
| `image_url` | `searchImage`, upgraded `http:` → `https:` | assets.myntassets.com |
| `size` | `inventoryInfo[].label` if present, else `sizes` | `S` / `XXS,XS,S,M,L,XL,XXL,3XL` |
| `in_stock` | any `inventoryInfo[].available` or `inventory > 0` | `true` |

Notes on the two that are not obvious:

* **`sizes` vs `inventoryInfo`.** `sizes` is the full *offered* size range as a
  comma string. `inventoryInfo` lists only the SKUs actually in stock, and when
  a `size_facet` filter is pushed it narrows to exactly the requested size. So
  `inventoryInfo` wins when present; `sizes` is the fallback.
* **`in_stock`.** There is no boolean stock flag. A PLP only lists buyable
  styles, so when `inventoryInfo` is missing entirely the honest fallback is
  `price > 0` rather than inventing a stock-out.
* `discount` is an *amount* in rupees (`780`), not a percentage;
  `discountDisplayLabel` carries the human string (`"(52% OFF)"`). The deal
  engine computes its own percentage from `mrp`/`price`, so neither is parsed.

### 1.2 Server-side filters — verified, not assumed

This is the reason Myntra is the retailer that makes the app's fashion filter
requirement cheap (spec §3). All three were confirmed by reading
`searchData.results.appliedParams` back off the response, not by eyeballing the
grid.

| Request | `totalCount` | `appliedParams` says |
| --- | --- | --- |
| `/men-tshirts` | 409,115 | nothing applied |
| `/men-tshirts?f=Brand:Nike` | 439 | `{"id":"Brand","values":["Nike"]}` |
| `/men-tshirts?f=Brand:Nike::size_facet:M` | 363 | `Brand` **and** `size_facet` |
| `/men-tshirts?rf=Price:0.0_1000.0_0.0 TO 1000.0` | — | `rangeFilters: Price 0→1000, "₹1000 and Below"` |
| `/men-tshirts?p=2` | — | page 2 |
| `/running-shoes?rawQuery=running shoes` | 18,757 | search works as a listing page |
| `/sale` | 8,222,320 | 8.2 MB (!) — the discount sweep entry point |

Grammar, exactly as implemented in `build_facet_param` / `build_range_param`:

* facet name and value are joined with `:` — `Brand:Nike`
* multiple values inside one facet with `,` — `Brand:Nike,Puma`
* separate facets with `::` — `Brand:Nike::size_facet:M`
* price is a **separate** parameter `rf`, with Myntra's own redundant form
  `Price:<lo>_<hi>_<lo> TO <hi>`; `lo = 0.0` is accepted and renders as
  "₹1000 and Below"
* the space inside `… TO …` must be `%20`. A `+` is **not** accepted, which is
  why `build_listing_url` uses `quote` with `safe=":,_"` rather than plain
  `urlencode`

Do not "tidy" the facet ids: `size_facet` really is snake_case while `Brand`,
`Color` and `Price` really are capitalised.

### 1.3 Facet enumeration (for the app's filter pickers)

`searchData.results.filters` is an object, not a list, with the facet groups
bucketed by presentation:

```
filters
├── primaryFilters[]   ← id: size_facet(43), Color(51), Brand(2431),
│                          Sections, Sub Categories, Categories, Bundles,
│                          Country of Origin
├── inlineFilters[]    ← the same facets again, different bucket
├── rangeFilters[]     ← id: Price (start/end/gap), Discount Range
├── nestedFilters[], geoSpecificFilters[], pillsFilters[], …
```

Each group is `{"id": "<facet name>", "filterValues": [...]}` and each value is
`{"id": "M", "value": "M", "count": 133, ...}`. **`filterValues[].id` is exactly
the token that must be echoed back in `?f=`** — which is why
`MyntraAdapter.facets()` exists: the picker offers real tokens with Myntra's own
result counts, and `plan_filters()` validates a requested filter against them.
A requested value that Myntra does not offer lands in `FilterPlan.rejected` and
is logged, instead of silently widening the sweep.

Measured facet sizes for `/men-tshirts`: **2,431 brands, 43 sizes, 51 colours**.

### 1.4 Block detection

Myntra never blocked us across ~10 requests, so there is **no captured block
fixture for Myntra** — and none was invented. Detection is therefore structural,
in this order:

1. a known interstitial marker (`access denied`, `request unsuccessful`,
   `incapsula incident`, `you have been blocked`, `validatecaptcha`);
2. a `window.__myx` blob present → **positively a real page**, whatever the size;
3. non-200;
4. body < 20,000 bytes.

> **A bare `"captcha"` marker was tried and rejected.** The genuine 1.4 MB Myntra
> page contains the substring `captcha` in its bundled JS, so that check would
> have reported every successful sweep as a block. There is a regression test
> for this (`test_the_word_captcha_alone_does_not_flag_a_real_page`).

### 1.5 Pacing

Back-to-back requests with 6–7 s gaps were fine; no throttling, no 429s.
`core.http.DEFAULT_HOST_DELAYS` already has `www.myntra.com: 3.0`, which matches
what was measured. Keep it there.

---

## 2. Amazon.in — works, but the wall is real

### 2.1 The first request was blocked

A cold `GET https://www.amazon.in/s?k=running+shoes` with a plain Chrome UA
returned **503, 1,283 bytes**. That body is checked into
`tests/fixtures/amazon_block_503.html` verbatim. It contains:

```html
<title>503 - Service Unavailable Error</title>
<!-- To discuss automated access to Amazon data please contact
     api-services-support@amazon.com. ... -->
<b>It's rush hour and traffic is piling up on that page.</b>
```

Zero product cards. **Parsed naively this is indistinguishable from "your search
returned no results"** — and writing that to D1 would mark the whole category as
out of stock. Hence `AmazonBlocked`.

> **Spec correction (§3).** The spec records Amazon as "200, 72 ASINs, no
> captcha". That is achievable but is *not* the cold-start behaviour: a bare
> Chrome UA on a fresh connection got a 503 wall on the very first request.

### 2.2 What made it work

A `requests.Session` with the full Chrome header set, plus one warm-up hit on
`https://www.amazon.in/` before the search:

```
User-Agent, Accept, Accept-Language, Accept-Encoding,
sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform,
Sec-Fetch-Dest/Mode/Site/User, Upgrade-Insecure-Requests
```

Result: home → `202, 2,012 bytes` (itself a soft wall, but it sets the session
cookie), then search → **200, 2,857,780 bytes, 60 result cards, 102 nodes with
`data-asin`**. No captcha.

`core.http.DEFAULT_HEADERS` today carries `Sec-Fetch-*` and `Upgrade-Insecure-
Requests` but **not** the `sec-ch-ua*` client hints, and the shared client does
no warm-up. That is a known gap, recorded here rather than fixed inside another
agent's module — see "Open items" below.

### 2.3 DOM paths (measured, not guessed)

HTML only — there is no JSON island on the SERP. Parsed with **selectolax**
(`lxml` is not installed and needs a compiler on Windows; selectolax is pure C
wheel and fast).

| Offer field | Selector |
| --- | --- |
| card | `div[data-asin][data-component-type="s-search-result"]` |
| `ext_id` | `@data-asin` (validated `^[A-Z0-9]{10}$`) |
| `brand` | `[data-cy="title-recipe"] h2.a-size-mini span` |
| `name` | `[data-cy="title-recipe"] a h2@aria-label` (fallback: its text, then `img.s-image@alt`) |
| `price` | first `span.a-price` **without** `a-text-price`, then its `span.a-offscreen` |
| `mrp` | `span.a-price.a-text-price span.a-offscreen` |
| `image_url` | `img.s-image@src` |
| `in_stock` | `false` only if `span.a-color-price`/`a-color-error` says "currently unavailable" / "out of stock" |
| `size` | **not available** |

Two traps that cost real time:

* **The first `h2` is the brand, not the title.** Amazon's current layout renders
  `<h2 class="a-size-mini"><span>ASIAN</span></h2>` for the brand and a *second*
  `<h2 aria-label="Wonder-13 Men's Running Shoe | …">` inside the result link for
  the product. Reading "the h2" gives you `ASIAN` and nothing else.
* **`span.a-price-whole` truncates paise** (`1,999` for ₹1,999.00) and appears in
  both the live price and the struck-through M.R.P. The `a-offscreen`
  screen-reader copy carries the full value, and the `a-text-price` class is the
  only reliable way to tell M.R.P. from selling price.

**Sponsored results are excluded by default.** 12 of the 60 cards were ads
(`[data-component-type="s-impression-logger"]`, and their `aria-label`/`alt`
start with `Sponsored Ad - `). Ad prices are not the retailer's standing price
and would skew the history. `parse_offers(..., include_sponsored=True)` is there
for the compare screen if it is ever wanted.

**URLs are rebuilt as `https://www.amazon.in/dp/<ASIN>`**, never taken from the
`href`: sponsored cards link through `/sspa/click?...` with a tracking blob that
expires within hours, and organic hrefs carry a `qid`/`dib` session token.

**Size is genuinely absent** from Amazon SERP cards — it lives only on the detail
page. `apply_filters()` therefore *ignores* a size filter for Amazon rather than
honouring it, because honouring it would discard every result. This is a stated
limitation, tested (`test_size_filter_is_ignored_rather_than_wiping_the_result`).

### 2.4 Block detection

In order:

1. wall markers — `api-services-support@amazon.com`, `/errors/validateCaptcha`,
   `captcha/`, `Enter the characters you see below`,
   `Type the characters you see in this image`,
   `To discuss automated access to Amazon data`. Every one of these was checked
   against the real 2.8 MB SERP and is absent from it;
2. `data-component-type="s-search-result"` present → **positively a real SERP**;
3. HTTP 503 → the rush-hour wall;
4. any other non-200;
5. body < 100,000 bytes.

A 200 with real cards but zero parseable offers is reported as `ok` with an
empty list — that is an honest empty result, not a block. A large 200 with *no*
cards at all is reported as a block, because Amazon does not serve card-less
SERPs.

### 2.5 Pacing

No official API exists: **PA-API 5.0 is deprecated (sunset ~May 2026)** and needs
an affiliate account with qualifying sales, which a single-user tool cannot get.
Do not attempt it.

8 s between requests kept a warmed session alive for the whole probe run; faster
earned an immediate 503. `core.http.DEFAULT_HOST_DELAYS` currently says
`www.amazon.in: 3.0`, which is optimistic — `AmazonAdapter` documents 8 s as its
own measured figure. Raising the shared value is recommended.

---

## 3. Flipkart — best effort, expected to fail

### 3.1 Throttling, measured

| Request | Result |
| --- | --- |
| cold `GET /search?q=running+shoes` (plain Chrome UA) | **403, 787 bytes** — reCAPTCHA wall |
| warmed session: `GET /` | **403, 787 bytes**, zero cookies set |
| then, 12 s later, `GET /search?q=running%20shoes` with `Referer` + `Sec-Fetch-Site: same-origin` | **200, 885,445 bytes** |

So the wall is not strictly "first request succeeds, rest fail" as the spec's
note suggests — it is closer to a coin flip weighted against you, and the home
page is *more* likely to be walled than the search page. Failing soft is the
correct behaviour, and this adapter is expected to return `[]` a good fraction of
the time.

The wall body is checked in verbatim as
`tests/fixtures/flipkart_block_403.html`:

```html
<title>Flipkart reCAPTCHA</title>
<h1 class=header>Are you a human?</h1>
```

### 3.2 Where the data is

Two payloads on a real page:

* `<script type="application/ld+json" nonce="…" id="jsonLD">` — an `ItemList`
  with **names and URLs only, no prices**. Note the `nonce` attribute: a regex
  matching `<script type="application/ld+json">` exactly will miss it.
* `<script nonce="…" id="is_script">window.__INITIAL_STATE__ = {…}` — the Redux
  store, which is where prices live.

Path, measured:

```
__INITIAL_STATE__
└── pageDataV4.page.data          {"10000":[…], "10002":[…], "10003":[…], "ROOT":[…]}
    └── <slotId>[]                slot ids are NOT stable
        └── widget{type:"PRODUCT_SUMMARY"}
            └── data.products[]   4 products per widget, 10 widgets = 40 total
                └── productInfo.value
```

Walking only the first `PRODUCT_SUMMARY` widget would lose 90 % of the page, so
`iter_product_values` walks every slot and every widget.

| Offer field | Path under `productInfo.value` |
| --- | --- |
| `ext_id` | `id` (`SHOHGHSC6KZ2HQJ9`) |
| `name` | `titles.title` (fallback `titles.newTitle`) |
| `brand` | `titles.superTitle` |
| `size` | `titles.coSubtitle` = `"Size: 8"`, else tail of `titles.subtitle` = `"White , 8"` |
| `price` | `pricing.prices[]` entry with `strikeOff: false` (`priceType: SPECIAL_PRICE`) |
| `mrp` | `pricing.prices[]` entry with `strikeOff: true` (`priceType: FSP`, confusingly named "Selling Price") |
| `in_stock` | `buyability.intent != "negative"` — observed values `positive` / `negative` |
| `url` | `https://www.flipkart.com` + `baseUrl` |
| `image_url` | `media.images[0].url`, with `{@width}`/`{@height}`/`{@quality}` placeholders substituted and `http:` → `https:` |

Beware the price naming: Flipkart calls the **struck-out M.R.P.** "Selling
Price" (`FSP`) and the **actual price** "Special Price" (`SPECIAL_PRICE`). The
parser keys on `strikeOff`, not on the name, and falls back to min/max if a
third price type ever appears.

### 3.3 Block detection

1. wall markers — `Flipkart reCAPTCHA`, `Are you a human?`,
   `recaptcha/enterprise.js`;
2. `window.__INITIAL_STATE__` present → **positively a real page**;
3. non-200;
4. body < 50,000 bytes (the wall is 787 — the message names it explicitly).

> **`humanChallenge` was tried as a marker and rejected.** The genuine 886 KB
> search page ships a `humanChallengeReducer` key in its Redux store, so that
> substring would have flagged every successful search as a block. Regression
> test: `test_human_challenge_reducer_does_not_flag_a_real_page`.

There is a fourth, subtler signal: if the ld+json `ItemList` lists products but
the Redux walk finds none, `parse_offers` raises `FlipkartParseError`. That is
*our* markup break, not a block and not an empty catalogue, and it is reported
as `error` rather than `blocked` so the operator fixes a path instead of chasing
an imaginary IP ban.

### 3.4 Pacing and sweep entry point

`core.http.DEFAULT_HOST_DELAYS` has `www.flipkart.com: 30.0`, which matches the
measurement. `FlipkartAdapter.DEFAULT_DELAY_SECONDS` documents 20 s as the floor.
Do not go below it.

`/offers-store` is the spec's deal-sweep entry point, but it renders a carousel
shell rather than a priced listing, so `build_sweep_url` uses a sorted
`/search?q=<category>&sort=price_asc` instead — which does return prices. The
constant `OFFERS_PATH` is kept for whoever wants to revisit it.

---

## 4. Fixtures

All four are real captures, trimmed only by deleting entries — no field was
edited or synthesised. Each carries an HTML comment saying what was trimmed.

| File | Origin | Size |
| --- | --- | --- |
| `myntra_men_tshirts.html` | `/men-tshirts`, 1.4 MB → 6 products, facets capped at 12 values | 14 KB |
| `amazon_running_shoes.html` | `/s?k=running+shoes`, 2.8 MB → 6 of 60 cards (2 sponsored, 4 organic) | 105 KB |
| `amazon_block_503.html` | the real 503 wall, **verbatim** | 1,283 B |
| `flipkart_running_shoes.html` | `/search?q=running+shoes`, 886 KB → 5 of 40 products (one sold out) | 8 KB |
| `flipkart_block_403.html` | the real reCAPTCHA wall, **verbatim** | 787 B |

There is deliberately **no Myntra block fixture**: Myntra never blocked us, and
fabricating one would make the test lie about what has been observed.

Because the fixtures are trimmed they fall below each adapter's byte threshold,
which is exactly why `detect_block` treats a positive content marker
(`__myx` / result cards / `__INITIAL_STATE__`) as proof of a real page *before*
it falls back to size. That ordering is what lets the offline fixtures travel
the full adapter path, block detection included, with no network.

---

## 5. Design decisions worth knowing

* **A block is never an empty result.** Every adapter raises a
  `<Retailer>Blocked` exception at the fetch boundary and records
  `last_status ∈ {ok, blocked, error, idle}` plus `last_error`. `BaseAdapter`
  still turns everything into `[]` at the public boundary (spec §6), so the
  sweep continues — but the caller can read `adapter.blocked` and the log line
  says `BLOCKED (not empty)`.
* **Three separate exception types** (`MyntraBlocked`, `AmazonBlocked`,
  `FlipkartBlocked`) rather than one shared base, because there is no shared
  module these adapters own. A `RetailerBlocked` base in `core.types` would be a
  strict improvement — see below.
* **Fetch is separate from parse everywhere.** `parse_offers`, `parse_facets`,
  `detect_block`, `build_*_url` and `plan_filters` are pure functions over
  strings/dicts; only `fetch_page` touches the network. That is what makes the
  fixture tests possible (spec §13).
* **Filters push where they can.** Myntra: brand, size and price all go into the
  URL. Flipkart: client-side via the shared `Filters.matches`. Amazon:
  client-side, size deliberately ignored.
* **`Category.id` is the retailer path; `Category.slug` is the D1 key.** So the
  Myntra URL is built from `id` (`men-tshirts`) while `Offer.category` gets
  `slug` (`tshirts`), per `core.types.Category`'s own docstring.

---

## 6. Live end-to-end results through `core.HttpClient`

Run 2026-09-12, real network, the finished adapters driving the shared client.

| Call | Result |
| --- | --- |
| `MyntraAdapter().sweep(Category(id="men-tshirts", slug="tshirts", …))` | **50 offers, `ok`** |
| `MyntraAdapter().facets(...)` | **2,434 brands, 43 sizes**, price range 125–304,093 |
| `MyntraAdapter().search("men tshirts", Filters(brands=("Nike",), sizes=("M",), max_price=2000))` | **50 offers, `ok`** — every result `brand == "Nike"`, every `size == "M"`, max price 1,996. Server-side, one request. |
| `AmazonAdapter().search("running shoes", Filters())` with the **stock** `HttpClient` | **0 offers, `blocked`** — 503 on all 4 retry attempts, reason `bot wall marker 'api-services-support@amazon.com'` |
| same, with `sec-ch-ua*` client hints added and one warm-up GET of `https://www.amazon.in/` | **48 offers, `ok`** |
| `FlipkartAdapter().search("running shoes", Filters())` with client hints + `Referer` + `Sec-Fetch-Site: same-origin` | **40 offers, `ok`** |

The Amazon pair is the important one: the *only* difference between `blocked`
and 48 offers was the client hints and the warm-up request. It also demonstrates
the block path working as designed under real conditions — the sweep got `[]`
and `last_status == "blocked"`, never "0 products in stock".

## 7. Open items for other collector modules

These are in files owned by other agents, recorded rather than edited:

1. **`adapters/base.py` imports `core.http` / `core.types` without the package
   prefix**, while `tests/test_engine.py` imports `collectors.engine...`. Both
   only resolve because `tests/conftest.py` puts `collectors/` on `sys.path`
   *and* pytest puts the repo root there. Pick one convention — `collectors.*`
   throughout is the safer one, since a dual path lets the same class be
   imported under two identities.
2. ~~**`core.http.DEFAULT_HOST_DELAYS["www.amazon.in"] = 3.0` is optimistic.**
   Measured safe pacing is 8 s; 3 s reliably earned a 503.~~ **Fixed
   2026-09-12**: the delay now comes from `core.http.HOST_PROFILES` and
   Amazon's entry is 8.0 s. See `core/README-http.md`.
3. ~~**`core.http` has no `sec-ch-ua*` client hints and no per-host warm-up.**~~
   **Fixed 2026-09-12** exactly as suggested below: a per-host `warmup_url` and
   header overlay live in `core.http.HOST_PROFILES`, and the full client-hint
   set is derived from one `CHROME_MAJOR` constant so the hints cannot drift
   away from the User-Agent. Original note kept for the record:
   This is not a theory: with the stock client Amazon returned 503 on all four
   retry attempts; adding `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`,
   `Sec-Fetch-User` and a warm-up GET of `https://www.amazon.in/` turned the same
   call into 48 offers (§6). Flipkart likewise needed `Referer` +
   `Sec-Fetch-Site: same-origin`. Without these the fashion sweep will be blocked
   most of the time in Actions. Suggested shape: a per-host `warmup_url` and a
   per-host header overlay on `HttpClient`.
4. **`adapters/__init__.py` eagerly imports every retailer module**, so one
   missing sibling breaks the whole package for everyone. Consider lazy imports
   or a registry.

## 8. Men's-only category mappings (2026-09-13)

Fashion is men's-only by product decision. The catalog slugs stay
gender-neutral (`fashion-tops`, not `fashion-mens-tops`) because
`prefs.enabled_categories`, the app's category picker and every stored
`products.category` value are keyed on them; the gender lives in each
adapter's `CATEGORY_IDS` instead.

**What was wrong before.** The fashion adapters never used `CATEGORY_IDS` at
all — they built their URL from `category_label(category)`, which returns
`Category.slug` first. So Amazon and Flipkart were searching for the literal
string `"fashion-tops"` and Myntra was requesting `myntra.com/fashion-tops`,
which is not a listing path. The women's apparel in the feed was not a leak:
it was whatever those sites made of a nonsense query.

Measured from a residential IP in India, sweeping each term directly:

| Retailer | Term | Result |
| --- | --- | --- |
| Myntra | `men-tshirts`, `men-casual-shirts` | 50 each |
| Myntra | `men-jeans`, `men-trousers` | 50 each |
| Myntra | `men-casual-shoes`, `men-sports-shoes` | 50 each |
| Myntra | `men-watches`, `men-wallets` | 50 each |
| Amazon | `men's t-shirts`, `men's casual shirts` | 48 each |
| Amazon | `men's jeans`, `men's trousers` | 48 each |
| Amazon | `men's casual shoes` / `men's sports shoes` | 47 / 48 |
| Amazon | `men's watches` / `men's wallets` | 48 / 47 |
| Flipkart | all eight | **403 reCAPTCHA wall on every one** |

Flipkart's terms are therefore **unverified**. They mirror the Amazon set, and
the adapter correctly reported `blocked` rather than an empty result (§3.1), so
this measures the wall and not the queries. Confirm them on the first clean
Flipkart run and amend both this table and the note in `flipkart.py`.

One catalog slug is now several retailer terms, so `_sweep` fans out and
de-duplicates by `ext_id` — the shape `bigbasket.py` already used. The
distinction between a mapped `Category` (must be mapped or it sweeps nothing)
and a bare `str` (a literal term, used by direct/ad-hoc calls) lives in
`BaseAdapter.sweep_terms`.
