# `core.http` — the shared client

One `HttpClient` per process, one `requests.Session` inside it, one cookie jar.
Everything that touches the network goes through it (spec §6, §13), which is
what keeps every parser a pure function of bytes and every test offline.

## Why it looks like this

Measured 2026-09-12 against the live sites (`adapters/FASHION-NOTES.md` §6):

| Call | Result |
| --- | --- |
| Amazon search, stock client (plain Chrome UA, no hints, no warm-up) | **0 offers, `blocked`** — 503 on all 4 retry attempts |
| Same search + `sec-ch-ua*` hints + one warm-up GET of `https://www.amazon.in/` | **48 offers, `ok`** |
| Flipkart search + hints + `Referer` / `Sec-Fetch-Site: same-origin` | 40 offers, `ok` |

So the client hints and the warm-up are not cosmetics; they are the difference
between a fashion sweep and a blocked one.

## 1. One browser identity, one source of truth

`CHROME_MAJOR` drives **both** `USER_AGENT` and `SEC_CH_UA`. A Chrome 131 UA
sitting next to `"Chromium";v="128"` hints is a *louder* bot signal than sending
no hints at all, so the two cannot be edited apart.

Every request carries the full Chrome navigation set:

```
User-Agent                  Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/131.0.0.0 Safari/537.36
Accept                      text/html,application/xhtml+xml,…,application/signed-exchange;v=b3;q=0.7
Accept-Language             en-IN,en;q=0.9
Accept-Encoding             gzip, deflate          (no `br` — brotli is not a hard dependency)
sec-ch-ua                   "Not_A Brand";v="24", "Chromium";v="131", "Google Chrome";v="131"
sec-ch-ua-mobile            ?0                     (the UA is a desktop UA)
sec-ch-ua-platform          "Windows"              (matches `Windows NT 10.0` in the UA)
Sec-Fetch-Dest              document
Sec-Fetch-Mode              navigate
Sec-Fetch-Site              none  → same-origin after warm-up
Sec-Fetch-User              ?1    → dropped after warm-up
Upgrade-Insecure-Requests   1
Referer                     (absent) → the host's home page after warm-up
```

Precedence, lowest first: `DEFAULT_HEADERS` → the warmed overlay → the host
profile's `headers` → **whatever the caller passed**. The caller always wins,
because BigBasket's `X-CSRFToken`/`X-Caller` block and Blinkit's `lat`/`lon`
headers are deliberate.

## 2. Per-host warm-up

`HttpClient.warm_up(host)` runs **once per host per process**, before that
host's first real request, and only for hosts whose profile sets `warmup_url`:

1. `limiter.wait(host)` — the warm-up is paced like anything else;
2. `GET <warmup_url>` with the cold header set: `Sec-Fetch-Site: none`,
   `Sec-Fetch-User: ?1`, no `Referer`;
3. keep whatever cookies come back in the shared jar;
4. every later request to that host gets `Sec-Fetch-Site: same-origin` and
   `Referer: <warmup_url>`, and drops `Sec-Fetch-User`.

It is **single-attempt and failure-swallowing** on purpose. Amazon's home page
answers `202`/2,012 bytes (a soft wall) and Flipkart's answers `403` about half
the time — yet the request still plants the session cookie, and the search that
follows returns a real page. Retrying a soft wall at 30 s pacing would only burn
Actions minutes. The host is marked warmed *before* the request, so a failure
does not cause a second attempt later.

`HttpClient(warm_up_enabled=False)` turns the whole thing off.

## 3. The profile table

One row per host in `HOST_PROFILES`; no `if host ==` anywhere in the client.
`DEFAULT_HOST_DELAYS` is derived from it, so the two cannot disagree.

| Host | Delay | Warm-up | Retries | Measurement |
| --- | --- | --- | --- | --- |
| *(default)* | 1.0 s | — | 4 | — |
| `blinkit.com` | 1.5 s | no | 4 | tolerates ~1 req/s over a 650-product sweep |
| `www.bigbasket.com` | 4.0 s | no | 4 | 2.0 s earned sustained 429s from listing-svc; 4.0 s held. The adapter GETs `/` itself in its location handshake, so a client warm-up would be a wasted hit |
| `www.myntra.com` | 3.0 s | no | 4 | never blocked across ~10 requests; one cold GET returns the full 1.4 MB `__myx` page |
| `www.amazon.in` | **8.0 s** | `https://www.amazon.in/` | 4 | 3.0 s reliably earned a 503; 8 s held for a whole run. Hints + warm-up: 0 offers → 48 |
| `www.flipkart.com` | 30.0 s | `https://www.flipkart.com/` | **2** | a second request inside ~30 s is throttled. The wall is an intermittent coin flip, not a rate limit, so 4 attempts at 30 s costs two minutes for almost no extra success — fail soft (spec §6) |

Adding a retailer means adding a row, not adding a branch.

## 4. Unchanged contract

Per-host pacing, exponential backoff with jitter, `Retry-After` honoured on
`403/408/425/429/5xx`, and `limiter.penalise(host, wait)` after a block so a
*second* adapter on the same host inherits the penalty rather than walking
straight into it. A per-host `attempts` only changes the budget, not the shape.

## 5. Testing

`tests/conftest.py` blocks `socket.connect`, so every test here is offline:
`FakeSession` for header/warm-up/pacing assertions and a `requests` transport
adapter (`_RecordingAdapter`) for the real cookie-jar round trip. Do **not**
probe the live sites to "check" a measurement — the recorded ones are in
`adapters/FASHION-NOTES.md`, and a burst of probing risks the project's only
free data source.
