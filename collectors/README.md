# collectors/

Python 3.11+ (built and tested on 3.12.10). Fetch, parse, normalise. Knows
nothing about D1 or the app — it produces `Offer` records and hands them on.

```
core/        types.py  http.py  ratelimit.py  categories.py
adapters/    base.py   blinkit.py  bigbasket.py   (+ myntra/amazon/flipkart)
tests/       fixture-driven parser tests, offline
```

```bash
cd collectors
python -m pytest          # all offline, no network
```

`pyproject.toml` puts the repo root on `sys.path`, so modules import as
`collectors.core.types`, `collectors.adapters.blinkit`, and no install step is
needed. `tests/conftest.py` monkeypatches `socket.create_connection` and
`socket.socket.connect` for every test, so a test that reaches for the network
fails loudly instead of quietly passing in CI and quietly failing offline
(spec §13).

---

## The contract

Every adapter is `collectors.adapters.base.Adapter` (spec §6) and inherits the
fail-soft boundary from `BaseAdapter`: subclasses implement `_sweep` / `_search`
and may raise; `sweep()` / `search()` log and return `[]`. One broken retailer
never costs the others their data.

Parsing is always a pure function of bytes — `parse_category_page(html, slug)`,
`parse_offers(payload, slug)` — separate from the fetch, which is the only
reason the tests can be offline.

## Rate limiting

`core/http.py` is the only thing that touches the network. One desktop Chrome
User-Agent, `Accept-Language: en-IN,en;q=0.9`, gzip, a 30 s timeout, and
`core/ratelimit.py` enforcing a **per-host** minimum interval before every
request. Blocking statuses (403/408/425/429/5xx) are retried with exponential
backoff, jitter and `Retry-After` support, and the backoff is also charged to
the shared limiter so a second adapter on the same host inherits the penalty
instead of walking into the block.

Defaults (`DEFAULT_HOST_DELAYS`), all measured:

| host | delay |
| --- | --- |
| `blinkit.com` | 1.5 s |
| `www.bigbasket.com` | 4.0 s |
| `www.flipkart.com` | 30.0 s |
| `www.myntra.com` / `www.amazon.in` | 3.0 s |

The limiter is tested with an injected clock in `tests/test_core_http.py` — no
sleeping, no network.

---

## Blinkit — works

`GET https://blinkit.com/cn/<slug>/cid/<l0>/<l1>` → 200, ~1 MB, catalogue
server-rendered into `window.grofers.PRELOADED_STATE`. No browser, no TLS
impersonation, a browser UA is enough.

* Products: `ui.plpContainer.feedData.snippets[]`, widget type
  `product_card_snippet_type_2`.
* `tracking.common_attributes` carries **numeric** `price`, `mrp`, `brand`,
  `name`, `product_id`, `inventory` — this is what the adapter reads. The
  display half (`data`) supplies pack size (`variant`), image, `merchant_id`
  and the sold-out flags, and is the fallback when tracking is absent.
* Variants (other pack sizes) are nested under a card's `variant_list` and are
  real SKUs with their own ids and prices, so they are collected too and
  deduped by `product_id`.
* Deep link: `https://blinkit.com/prn/<name-slug>/prid/<id>`. Verified — the
  slug is cosmetic, only `prid` resolves. The page itself only exposes
  `grofers://pdp?...` app deeplinks, which are useless in a browser.
* Pagination: `feedData.pagination.next_url` →
  `POST /v1/layout/listing_widgets?...`. **POST only; GET returns 404.** Same
  snippet envelope, so the same parser. `extra_pages = 2` by default.
* Search: the `/s/?q=` page is client-rendered and contains no products.
  `POST /v1/layout/search?q=...` returns the same envelope.

**Location: solved.** Send `lat` / `lon` **request headers**. The returned
`merchant_id` (serving dark store) changes with them — 31719 for the IP default
(Gurugram), 30377 for Bengaluru — which is how we know prices are dark-store
specific and not a cached default. `gr_1_lat` / `gr_1_lon` cookies work
identically; the adapter uses headers.

Live sweep 2026-09-12 from Koramangala (12.9261, 77.6221), 5 categories:
451 offers, 419 in stock.

## BigBasket — works

Two verified ways in, same product schema:

1. `GET /cl/<slug>/` → 200, 2–3 MB of HTML, one `<script id="__NEXT_DATA__">`
   blob; products at `props.pageProps.SSRData.tabs[0].product_info.products`
   (48 per page, `?page=N`).
2. `GET /listing-svc/v2/products?type=pc&slug=<slug>&page=N` → the same data as
   ~840 KB of JSON, and `type=ps&slug=<query>` gives search.

**The listing service 500s with `PL5012` unless the request carries
`X-Caller: UIKIRK`.** That single header (lifted from the site's own
`COMMONHEADERS`) is the entire difference between a 500 and a 200. It is the
default path here because it is a quarter of the bytes; `use_api = False`
falls back to the HTML page.

Fields: `pricing.discount.mrp`, `pricing.discount.prim_price.sp` (selling
price, `.rsp` as fallback), `availability.avail_status` (`"001"` in stock,
`"010"` notify-me), `brand.name`, `desc`, `w`, `images[0].l`, `absolute_url`.
The offer `name` is `brand.name + " " + desc`, which is how the site itself
renders it. `children[]` are the other pack sizes and become their own offers.

Spec §6's rule holds: `/pd/<id>/` product-detail pages 429 immediately.
Nothing here fetches one — `absolute_url` is recorded as a deep link only.

Live sweep 2026-09-12 from pincode 560034, 5 categories, 3 pages each:
650 offers, 581 in stock. Six transient 429s, all absorbed by the retry budget;
no category lost.

### The pincode handshake — RESOLVED

Spec §6 left "the exact pincode-to-cookie handshake for BigBasket" as the one
outstanding piece of reverse engineering. It is four unauthenticated calls,
reverse-engineered out of the site's own webpack chunk `89284`:

```
1. GET  /places/v1/places/autocomplete/?inputText=<pincode>&token=<uuid4>
        -> predictions[0].placeId            (Google Places proxy; token is
                                              just a client-side uuid4)
2. GET  /places/v1/places/details/?placeId=..&token=<uuid4>&xArm=0&yArm=0
        -> geometry.location.{lat,lng}
3. GET  /ui-svc/v1/serviceable?lat=..&lng=..&send_all_serviceability=true
        -> places_info {area, pincode, city, lat, lng}
           serviceable_ecs_info {bbnow: {serviceable: "bb2.0"}, ...}
           (also sets the csurftoken cookie step 4 needs)
4. PUT  /member-svc/v2/member/current-delivery-address/
        {area, contact_zipcode, lat, long, return_hub_cookies: false}
   GET  /ui-svc/v2/header/?send_door_info=true
        -> additional_cookies  <- THIS IS THE ANSWER
```

`additional_cookies` for 560034:

```json
{"_bb_pin_code": "560034", "_bb_sa_ids": "16535,20713,24557",
 "_bb_addressinfo": "MTIuOTI2MTM4Mnw3Ny42MjIxMDkxMDAwMDAwMnxTLlQuIEJlZCwgS29yYW1hbmdhbGF8NTYwMDM0fEJlbmdhbHVydXwxfGZhbHNlfHRydWV8dHJ1ZXxCaWdiYXNrZXRlZXI=",
 "_bb_cda_sa_info": "djIuY2RhX3NhLjEwLjE2NTM1LDIwNzEzLDI0NTU3",
 "_bb_bb2.0": "1", "is_global": "0", "is_integrated_sa": "1", ...}
```

`_bb_addressinfo` is base64 of `lat|lng|area|pincode|city|…`;
`_bb_cda_sa_info` is base64 of `v2.cda_sa.<entry_context_id>.<sa_ids>`.
Apply the map to the session cookie jar on `.bigbasket.com` and every later
request is priced for that pincode. `_bb_cid` (city) is updated server-side by
step 4: 1 Bengaluru, 4 Mumbai, 18 Delhi.

Proof it actually changes the data — same URL, same session, different pincode:

| location | `total_count` on `/cl/beverages/` | SKU 40211241 |
| --- | --- | --- |
| IP default (no handshake) | 2978 | ₹108 |
| 560034 Koramangala | 782 | ₹130 |
| 400001 Chembur | 861 | ₹130 |

**Setting `_bb_pin_code` by hand does not work** and this is worth stating
plainly: the server rewrites `_bb_pin_code` to empty and `_bb_locSrc` back to
`default` on the next page load, and prices do not move. The handshake is
mandatory. Any "just set the pincode cookie" approach is a silent no-op that
returns a plausible-looking but wrong (IP-derived) catalogue.

`BigBasketAdapter.resolve_location_cookies(loc)` performs the handshake;
`ensure_location(loc)` runs it once per pincode per process. The fallback the
task asked for exists anyway: `BigBasketAdapter(cookies={...})` accepts a
pre-captured cookie map and skips the handshake entirely, for the day
BigBasket changes the flow.

Entry context: the quick-commerce catalogue is `xentrycontext=bbnow` /
`xentrycontextid=10`, which BigBasket sets itself on a first visit and the
adapter pins.

---

## Discrepancies against the task notes

Trusting the measurement, as instructed:

1. **"BigBasket `/cl/<slug>/` → ~350 products"** — the page returns 48 top-level
   products per page (158 including `children[]` variants), with
   `number_of_pages: 63` and `total_count: 2978` for `beverages` at the IP
   default. The "~350 occurrences of `sp`" in the note is a substring count
   across the blob, not a product count. Sweeping is therefore explicitly
   paginated (`BigBasketAdapter.pages = 3`), not a single fetch.
2. **"Blinkit … ~727 `"mrp":` entries"** — reproduced exactly for
   `munchies`, but that is again a substring count. The page server-renders
   **30** product cards (45 distinct products once nested variants are counted);
   `pagination.total_pagination_items` says 650 exist. Hence `extra_pages`.
3. **BigBasket `_bb_locSrc` / `_bb_cid` / `_bb_nhid`** are set by the server on
   any first request and are *not* ours to set. Of the four, only `_bb_cid`
   tracks the chosen location, and it does so as a *result* of the handshake.
   `_bb_nhid` stayed `7427` for every pincode tested — it is not the hub id the
   note implies when `return_hub_cookies: false` (which is what the site sends
   for a signed-out visitor).
4. **`x-entry-context: bbnow` header** — carried as cookies
   (`xentrycontext` / `xentrycontextid`) rather than a header on the HTML
   request; the adapter sends both.
5. **Blinkit "`lat`/`lon`/`merchant_id`/`locality` exposed in the response"** —
   true, but `locality`/`lat`/`lon` live in `data.location.coords` (echoing
   *our* request), and `merchant_id` is per product card, not top-level.
6. **Blinkit `"name"`/`"display_name"`/`"price"`/`"mrp"` on the product** —
   `name`, `display_name` and `mrp` are *rendering objects*
   (`{"text": "₹50", "color": …}`), not values; there is no `price` key on
   `data` at all (it is `normal_price`). The numeric fields are in
   `tracking.common_attributes`. Parsing the display strings works but is the
   fallback path here.

## Things to watch

* **Blinkit 403s in bursts.** During reverse engineering a rapid sequence of
  requests produced 403 on every category for a few minutes, then recovered
  with no change to the request. This is why the retry budget and per-host
  pacing exist, and why a live smoke check is allowed to fail without breaking
  the build (spec §13).
* **BigBasket returns `SSRData: null`** rather than an error for a location it
  cannot serve (seen for Delhi 110001, whose `_bb_cda_sa_info` decodes to entry
  context `100`, i.e. not `bbnow`). `product_info()` normalises that to "no
  products" instead of raising, so an unserviceable pincode yields an empty
  sweep, not a crash.
* **BigBasket 429s a deep sweep.** At 2 s/request `listing-svc` started
  returning 429 part-way through the 15-page run; 4 s held. A page that fails
  no longer discards the pages already collected — the sweep breaks and returns
  what it has.
* **The Places proxy's `token`** is a client-side uuid4 with no server
  validation beyond being well-formed-ish; a reused literal was rejected once
  as `Invalid Token`, so a fresh uuid4 per call is used.

## Category seed

`core/categories.py` seeds the five quick-commerce categories from spec §7's
model (snacks, beverages, dairy, staples, personal care) against both
retailers. The `slug` is retailer-independent and is what lands in
`products.category`; the `id` is the retailer's own addressing.

Every URL was fetched on 2026-09-12 before being committed:

| slug | Blinkit `cid/scid` | BigBasket `/cl/` | BB products |
| --- | --- | --- | --- |
| snacks | `munchies/cid/1237/940` | `snacks-branded-foods` | 3679 |
| beverages | `cold-drinks-juices/cid/332/1102` | `beverages` | 782 |
| dairy | `dairy-bread-eggs/cid/14/922` | `bakery-cakes-dairy` | 1469 |
| staples | `atta-rice-oil-dals/cid/16/957` | `foodgrains-oil-masala` | 2661 |
| personal-care | `bath-body/cid/273/1026` | `beauty-hygiene` | 4033 |

BigBasket slugs come from the live `/ui-svc/v1/category-tree`, not from
guessing.

## Fixtures

Real responses, trimmed to a handful of products but structurally untouched,
captured 2026-09-12:

| file | source |
| --- | --- |
| `blinkit_category_munchies.html` | `GET /cn/munchies/cid/1237/940` |
| `blinkit_search_amul_milk.json` | `POST /v1/layout/search?q=amul+milk` |
| `bigbasket_category_beverages.json` | `GET /listing-svc/v2/products?type=pc&slug=beverages` |
| `bigbasket_category_beverages.html` | `GET /cl/beverages/` |
| `bigbasket_search_amul_milk.json` | `GET /listing-svc/v2/products?type=ps&slug=amul%20milk` |
| `bigbasket_header_560034.json` | `GET /ui-svc/v2/header/?send_door_info=true` |
| `bigbasket_serviceable_560034.json` | `GET /ui-svc/v1/serviceable?lat=…&lng=…` |

The Blinkit HTML fixture deliberately keeps the trailing
`;window.grofers.ENV = {…}` after the state object, because a parser that reads
to the last `}` would break on the real page and pass on a naive fixture.

## Legal

Spec §15: scraping these sites is contrary to the retailers' terms of service.
This is a single-user, low-volume, personal-use tool that reads publicly
visible prices and places no orders.
