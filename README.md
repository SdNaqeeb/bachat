# Bachat

A personal price comparison app for Indian quick-commerce and fashion retail.
One screen replaces opening five apps.

```
collectors/   Python adapters + deal engine, run by GitHub Actions
worker/       Cloudflare Worker + D1 — the REST API and price history
mobile/       Expo / React Native app  ->  signed Android APK
```

Runs entirely on free tiers. No credit card, no monthly bill.

---

## What it does

The problem it solves is a daily chore: opening Blinkit, Zepto, Instamart,
BigBasket and Amazon one after another to compare prices by hand before
ordering, and the same again across Myntra and Ajio for clothes.

So the app is a **decision screen**, not a deal feed:

- **Basket** — the things you actually buy, priced across every retailer, with
  the cheapest *basket total* called out. Totals include delivery and handling,
  because being ₹4 cheaper on one item means nothing if the rest of your list
  forces a second order and a second delivery fee.
- **Deals** — a category sweep of genuine discounts, scoped to the categories
  you care about.
- **Compare** — one item across every retailer, with size and brand filters in
  fashion mode.
- **Notifications** — deep discounts and period lows pushed to your phone with
  the app closed.

A Swiggy-style switch flips the whole app between **Quick Commerce** and
**Fashion**, which also decides which collectors run and which alerts reach you.

## Getting it running

See **[SETUP.md](./SETUP.md)** — start to finish, about an hour, all free.

Want to see it before setting anything up? `EXPO_PUBLIC_DEMO=1` (the default)
runs the whole app against a bundled fake catalog, no backend required.

## How it is put together

```
GitHub Actions (Python, cron)             Cloudflare
┌────────────────────────────┐           ┌───────────────────┐
│ adapters/  blinkit         │           │ Worker (REST)     │◄─── phone
│            bigbasket       │──ingest──►│ D1 (price history)│
│            myntra          │           └───────────────────┘
│            amazon          │
│            flipkart        │
│ engine/    deal detection  │───FCM high-priority push────► phone (app closed)
└────────────────────────────┘
```

Collectors run in GitHub Actions rather than in the Worker for a specific
reason: Cloudflare's free tier caps a Worker at 50 outbound requests and 10 ms
of CPU per invocation, which no real scraper fits inside. Actions has neither
limit. The Worker only reads and writes D1; it never touches a retailer.

Design and the reasoning behind it:
[docs/superpowers/specs/2026-09-12-bachat-design.md](./docs/superpowers/specs/2026-09-12-bachat-design.md).

## The honesty rule

No source sells Indian price history, so the app builds its own by polling and
storing. That has a consequence worth stating plainly: **on day one there is no
history**, and the app will say *"Lowest in 1 day"* rather than pretending
otherwise. A real 30-day claim only appears once 30 days of data exist.

This is enforced independently in three places — the Python engine that fires
alerts, the Worker that serves the API, and the app's decoder, which *refuses*
a period-low claim that arrives without a day count rather than guessing. No
component can render "30-day low" by writing the string; it can only come from
reading real history depth.

## Retailers

| Shipping | Deferred | Blocked |
| --- | --- | --- |
| Blinkit, BigBasket | Zepto, Swiggy Instamart | Ajio, Nykaa Fashion |
| Myntra, Amazon.in, Flipkart | Amazon Now, Flipkart Minutes | |

Deferred means technically possible but not free: Zepto and Instamart need a
headless browser, which does not fit the Actions minute budget. Blocked means
Akamai returns 403 to anything we can send without paying for residential
proxies. Adding any of them later is one new file behind the same adapter
interface.

Quick-commerce prices are **hyperlocal** — the same Blinkit category returns a
different dark store and different prices from Gurugram than from Bengaluru —
so your pincode and coordinates are part of the configuration, not a detail.

## Tests

```bash
cd collectors && python -m pytest -q     # adapters, engine, push, http client
cd worker      && npm test               # basket ranking, honesty rule, ingest
cd mobile      && npm test               # decoders, contract, honesty rule
```

Collector tests run with sockets blocked, so a test that reaches the network
fails loudly rather than passing locally and failing in CI. Adapter parsers are
tested against saved fixtures of real pages, which is what contains a retailer's
markup change to a single file.

The app's decoder tests run against **real Worker responses** — `worker`'s
contract test serves genuine requests through the real app and writes the
response bodies out as fixtures the app then decodes. Neither side can drift
without a test failing.

## Scope

No checkout, cart or payment; tapping a result deep-links into the retailer's
own app to buy. No retailer credentials. No accounts — single user, one phone.
No iOS build, and no Play Store listing.

Reading these prices is contrary to the retailers' terms of service. This is a
single-user, low-volume, personal tool that reads publicly visible prices and
places no orders.
