"""Blinkit (quick commerce).

Measured 2026-09-11/12 from this machine with a plain HTTP GET and a desktop
Chrome UA -- no browser, no TLS impersonation:

* Category pages ``https://blinkit.com/cn/<slug>/cid/<l0>/<l1>`` return 200 with
  the whole first page of the catalogue server-rendered into a global::

      <script>window.grofers.PRELOADED_STATE = {...};window.grofers.ENV = ...

  Products live at ``ui.plpContainer.feedData.snippets[]``, each a
  ``product_card_snippet_type_2`` whose ``tracking.common_attributes`` carries
  the *numeric* ``price``, ``mrp``, ``brand``, ``name``, ``product_id`` and
  ``inventory``. The display half (``data``) carries pack size, image, merchant.
* Location is set with ``lat`` / ``lon`` request headers. The returned
  ``merchant_id`` (the serving dark store) changes with them, which is how we
  know prices are location-specific and not a cached default. With no headers
  Blinkit falls back to an IP-derived default (Gurugram from here).
* Further pages come from ``POST /v1/layout/listing_widgets?...`` -- the URL is
  handed to us in ``feedData.pagination.next_url``. It is POST-only; GET 404s.
* Search is client-rendered, so the search *page* has no products. The API
  behind it, ``POST /v1/layout/search?q=...``, returns the same envelope.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

from collectors.adapters.base import BaseAdapter, to_float
from collectors.core.types import Category, Filters, Location, Offer

BASE = "https://blinkit.com"
STATE_MARKER = "window.grofers.PRELOADED_STATE = "
_SLUG_RE = re.compile(r"[^a-z0-9]+")


# --------------------------------------------------------------------------
# parsing (pure; no network, exercised by tests against saved fixtures)
# --------------------------------------------------------------------------
def extract_state(html: str) -> dict[str, Any]:
    """Pull ``window.grofers.PRELOADED_STATE`` out of a category page."""
    start = html.find(STATE_MARKER)
    if start < 0:
        raise ValueError("blinkit: PRELOADED_STATE not found in page")
    start += len(STATE_MARKER)
    state, _ = json.JSONDecoder().raw_decode(html, start)
    if not isinstance(state, dict):
        raise ValueError("blinkit: PRELOADED_STATE was not an object")
    return state


def iter_product_cards(node: Any) -> Iterator[dict[str, Any]]:
    """Yield every product-card snippet anywhere in a layout payload.

    Cards nest: a card's ``variant_list`` holds its other pack sizes, which are
    separate SKUs with their own ids and prices, so we want them. Callers
    dedupe by ``product_id``.
    """
    if isinstance(node, dict):
        if str(node.get("widget_type", "")).startswith("product_card") and isinstance(
            node.get("data"), dict
        ):
            yield node
        for value in node.values():
            yield from iter_product_cards(value)
    elif isinstance(node, list):
        for value in node:
            yield from iter_product_cards(value)


def product_url(product_id: str, name: str) -> str:
    """Blinkit web PDP. The slug is cosmetic -- only ``prid`` is resolved."""
    slug = _SLUG_RE.sub("-", name.casefold()).strip("-") or "p"
    return f"{BASE}/prn/{slug}/prid/{product_id}"


def offer_from_card(card: dict[str, Any], category_slug: str) -> Offer | None:
    """Build an ``Offer`` from one product-card snippet, or None if unusable."""
    data = card.get("data") or {}
    attrs = ((card.get("tracking") or {}).get("common_attributes")) or {}

    ext_id = str(data.get("product_id") or attrs.get("product_id") or "").strip()
    if not ext_id:
        return None

    name = (
        attrs.get("name")
        or _text(data.get("display_name"))
        or _text(data.get("name"))
        or ""
    ).strip()
    if not name:
        return None

    price = to_float(attrs.get("price"))
    if price is None:
        price = to_float(_text(data.get("normal_price")))
    if price is None:
        return None

    mrp = to_float(attrs.get("mrp"))
    if mrp is None:
        mrp = to_float(_text(data.get("mrp")))

    in_stock = not bool(data.get("is_sold_out"))
    state = data.get("product_state")
    if state is not None:
        in_stock = in_stock and state == "available"
    inventory = attrs.get("inventory")
    if isinstance(inventory, (int, float)) and not isinstance(inventory, bool):
        in_stock = in_stock and inventory > 0

    brand = attrs.get("brand") or _text(data.get("brand_name"))
    return Offer(
        ext_id=ext_id,
        name=name,
        price=price,
        mrp=mrp,
        in_stock=in_stock,
        url=product_url(ext_id, name),
        category=category_slug,
        brand=str(brand).strip() or None if brand else None,
        size=_text(data.get("variant")) or None,
        image_url=_image_url(data),
    )


def parse_offers(payload: Any, category_slug: str) -> list[Offer]:
    """Every distinct offer in a layout payload (HTML state or API JSON)."""
    offers: dict[str, Offer] = {}
    for card in iter_product_cards(payload):
        offer = offer_from_card(card, category_slug)
        if offer is not None:
            offers.setdefault(offer.ext_id, offer)
    return list(offers.values())


def parse_category_page(html: str, category_slug: str) -> list[Offer]:
    """Offers from a saved ``/cn/...`` page. The offline entry point."""
    return parse_offers(extract_state(html), category_slug)


def next_page_url(payload: Any) -> str | None:
    """``pagination.next_url``, absolutised, if there is another page."""
    node: Any = payload
    if isinstance(node, dict) and "response" in node:
        node = node["response"]
    else:
        for key in ("ui", "plpContainer", "feedData"):
            if isinstance(node, dict) and key in node:
                node = node[key]
    pagination = node.get("pagination") if isinstance(node, dict) else None
    url = pagination.get("next_url") if isinstance(pagination, dict) else None
    if not url:
        return None
    return url if str(url).startswith("http") else BASE + str(url)


def merchant_id(state: Any) -> str | None:
    """The dark store that served this page -- proof the location took."""
    for card in iter_product_cards(state):
        mid = (card.get("data") or {}).get("merchant_id")
        if mid:
            return str(mid)
    return None


def _text(node: Any) -> str:
    if isinstance(node, dict):
        return str(node.get("text") or "").strip()
    if isinstance(node, str):
        return node.strip()
    return ""


def _image_url(data: dict[str, Any]) -> str | None:
    image = data.get("image")
    if isinstance(image, dict) and image.get("url"):
        return str(image["url"])
    container = data.get("media_container")
    items = container.get("items") if isinstance(container, dict) else None
    if isinstance(items, list):
        for item in items:
            url = ((item or {}).get("image") or {}).get("url")
            if url:
                return str(url)
    return None


# --------------------------------------------------------------------------
# adapter (network)
# --------------------------------------------------------------------------
class BlinkitAdapter(BaseAdapter):
    id = "blinkit"
    mode = "quick"

    #: Extra POST pages of 15 fetched after the ~30 server-rendered ones.
    #: Kept small: spec section 12 budgets ~6 min for the whole quick sweep.
    extra_pages: int = 2

    def location_headers(self, loc: Location) -> dict[str, str]:
        if not loc.has_coords:
            return {}
        return {"lat": f"{loc.lat}", "lon": f"{loc.lon}"}

    def category_url(self, category: Category) -> str:
        return f"{BASE}/cn/{category.id.strip('/')}"

    def _sweep(self, category: Category, loc: Location) -> list[Offer]:
        headers = self.location_headers(loc)
        response = self.client.get(self.category_url(category), headers=headers)
        response.raise_for_status()
        state = extract_state(response.text)

        found: dict[str, Offer] = {
            offer.ext_id: offer for offer in parse_offers(state, category.slug)
        }

        url = next_page_url(state)
        for _ in range(self.extra_pages):
            if not url:
                break
            try:
                page = self.client.post(
                    url,
                    headers={
                        **headers,
                        "content-type": "application/json",
                        "Referer": self.category_url(category),
                    },
                    json={},
                )
            except Exception:  # noqa: BLE001
                # Keep the server-rendered first page rather than losing the
                # whole category to a throttled continuation.
                self.log.warning(
                    "blinkit: pagination failed, keeping %d offers", len(found), exc_info=True
                )
                break
            if page.status_code != 200:
                break
            payload = page.json()
            for offer in parse_offers(payload, category.slug):
                found.setdefault(offer.ext_id, offer)
            url = next_page_url(payload)

        return list(found.values())

    def _search(self, q: str, f: Filters, loc: Location) -> list[Offer]:
        response = self.client.post(
            f"{BASE}/v1/layout/search",
            params={"q": q, "search_type": "type_to_search"},
            headers={
                **self.location_headers(loc),
                "content-type": "application/json",
                "Referer": f"{BASE}/s/",
            },
            json={},
        )
        response.raise_for_status()
        return [o for o in parse_offers(response.json(), "search") if f.matches(o)]
