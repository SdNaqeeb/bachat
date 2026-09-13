"""Flipkart fashion adapter -- best effort by design.

Flipkart server-renders its search results into a very large
``window.__INITIAL_STATE__`` blob (886 KB measured), and duplicates the product
*names and URLs only* into an ``application/ld+json`` ``ItemList``. Prices live
only in the Redux blob, so that is what is parsed; the ld+json is used purely as
a corroborating signal that we got a real page.

Flipkart also throttles harder than anything else in this project. It answers
automated traffic with a 787-byte "Flipkart reCAPTCHA / Are you a human?" page,
HTTP 403. That page contains zero products and would otherwise look exactly like
a successful search for a term with no matches -- hence
:func:`detect_block` and :class:`FlipkartBlocked`. Spec section 6 says a failing
adapter returns ``[]`` and the sweep continues; that is correct here, and this
adapter is expected to fail some of the time.

Verified live on 2026-09-12 -- see ``FASHION-NOTES.md``.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Callable, Final, Iterator, Literal
from urllib.parse import urlencode

from collectors.adapters.base import BaseAdapter
from collectors.core.http import HttpClient
from collectors.core.types import Category, Filters, Location, Mode, Offer

logger: Final = logging.getLogger(__name__)

ADAPTER_ID: Final = "flipkart"
MODE: Final[Mode] = "fashion"
BASE_URL: Final = "https://www.flipkart.com"

#: Deal sweep entry point.
OFFERS_PATH: Final = "/offers-store"

#: A real search page is ~886 KB; the reCAPTCHA wall is 787 bytes. Anything
#: under this is a block, full stop -- never an empty result set.
MIN_RESULTS_BYTES: Final = 50_000

#: Flipkart blocked every follow-up request during probing. Be slow.
DEFAULT_DELAY_SECONDS: Final = 20.0

_STATE_RE: Final = re.compile(
    r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\});?\s*</script>", re.DOTALL
)
_LD_JSON_RE: Final = re.compile(
    r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', re.DOTALL
)

#: Wall markers, each checked against a real 886 KB search page and absent from
#: it. ``humanChallenge`` was tried first and REJECTED: the genuine page ships a
#: ``humanChallengeReducer`` key in its Redux store, so it would have reported
#: every successful search as a block.
_BLOCK_MARKERS: Final = (
    "Flipkart reCAPTCHA",
    "Are you a human?",
    "recaptcha/enterprise.js",
)

_PRODUCT_WIDGET: Final = "PRODUCT_SUMMARY"


class FlipkartBlocked(RuntimeError):
    """Flipkart served its reCAPTCHA wall. Distinct from "no results"."""


class FlipkartParseError(RuntimeError):
    """A real page whose Redux shape no longer matches what we parse."""


# --------------------------------------------------------------------------
# URL building
# --------------------------------------------------------------------------


def category_label(category: Category | str | None) -> str:
    if category is None:
        return "offers"
    if isinstance(category, str):
        return category
    for attr in ("slug", "id", "label"):
        value = getattr(category, attr, None)
        if isinstance(value, str) and value.strip():
            return value
    return str(category)


def build_search_url(query: str, *, page: int = 1, sort: str | None = None) -> str:
    """``/search?q=<query>`` -- the only entry point verified to return prices."""
    params: list[tuple[str, str]] = [("q", query.strip())]
    if sort:
        params.append(("sort", sort))
    if page > 1:
        params.append(("page", str(page)))
    return f"{BASE_URL}/search?{urlencode(params)}"


def build_sweep_url(category: Category | str) -> str:
    """Sweep URL for ``category``.

    ``/offers-store`` is the documented deal landing page, but it renders a
    carousel shell rather than a priced listing, so a category sweep uses a
    discount-sorted search instead -- which does return prices.
    """
    return build_search_url(category_label(category), sort="price_asc")


# --------------------------------------------------------------------------
# Block detection
# --------------------------------------------------------------------------


def detect_block(status_code: int, body: str) -> str | None:
    """Return a block reason, or ``None`` if this looks like a real page."""
    head = body[:200_000]
    # 1. Positive block markers win outright -- a wall is a wall even at 200.
    for marker in _BLOCK_MARKERS:
        if marker in head:
            return f"reCAPTCHA wall marker {marker!r} (http {status_code})"
    # 2. A real Redux blob is proof of a real page, whatever its size.
    if _STATE_RE.search(body) is not None:
        return None
    if status_code != 200:
        return f"http {status_code}"
    if len(body) < MIN_RESULTS_BYTES:
        # Measured exactly 787 bytes for the wall. Call it out by name when it
        # matches, because that is the single most common Flipkart outcome.
        suffix = " (787-byte reCAPTCHA wall)" if len(body) < 2_000 else ""
        return f"body too small ({len(body)} bytes){suffix}"
    return "no window.__INITIAL_STATE__ in a 200 response"


# --------------------------------------------------------------------------
# Parsing -- pure functions over saved HTML
# --------------------------------------------------------------------------


def extract_state(html: str) -> dict[str, Any]:
    """Pull ``window.__INITIAL_STATE__`` out of a search page."""
    match = _STATE_RE.search(html)
    if match is None:
        raise FlipkartParseError("window.__INITIAL_STATE__ not found")
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError as exc:  # pragma: no cover - shape change
        raise FlipkartParseError(f"__INITIAL_STATE__ is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise FlipkartParseError("__INITIAL_STATE__ is not an object")
    return payload


def extract_ld_titles(html: str) -> list[str]:
    """Product names from the ``ld+json`` ``ItemList``.

    Prices are absent there, so this is only a corroborating signal: if the
    Redux parse yields nothing but ld+json lists products, the break is ours,
    not a block.
    """
    titles: list[str] = []
    for match in _LD_JSON_RE.finditer(html):
        try:
            payload = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        for block in payload if isinstance(payload, list) else [payload]:
            if not isinstance(block, dict) or block.get("@type") != "ItemList":
                continue
            for item in block.get("itemListElement") or []:
                if isinstance(item, dict) and item.get("name"):
                    titles.append(str(item["name"]))
    return titles


def iter_product_values(state: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Yield every ``productInfo.value`` in the page.

    Layout path measured on a real page::

        pageDataV4.page.data.<slotId>[] -> .widget{type: PRODUCT_SUMMARY}
                                         -> .data.products[]
                                         -> .productInfo.value

    Flipkart splits the grid across ~10 PRODUCT_SUMMARY widgets of 4 products
    each, and the slot ids are not stable, so every slot is walked.
    """
    data = ((state.get("pageDataV4") or {}).get("page") or {}).get("data")
    if not isinstance(data, dict):
        raise FlipkartParseError("pageDataV4.page.data missing")
    for slots in data.values():
        if not isinstance(slots, list):
            continue
        for slot in slots:
            if not isinstance(slot, dict):
                continue
            widget = slot.get("widget")
            if not isinstance(widget, dict) or widget.get("type") != _PRODUCT_WIDGET:
                continue
            for product in (widget.get("data") or {}).get("products") or []:
                if not isinstance(product, dict):
                    continue
                value = (product.get("productInfo") or {}).get("value")
                if isinstance(value, dict) and value.get("id"):
                    yield value


def _prices(value: dict[str, Any]) -> tuple[float | None, float | None]:
    """Return ``(price, mrp)``.

    Flipkart emits two entries: ``FSP`` ("Selling Price", ``strikeOff: true``)
    which is the M.R.P., and ``SPECIAL_PRICE`` ("Special Price",
    ``strikeOff: false``) which is what you pay. Falling back to
    min/max keeps this working if a third price type appears.
    """
    entries = [
        e for e in ((value.get("pricing") or {}).get("prices") or []) if isinstance(e, dict)
    ]
    amounts = [
        (float(e["value"]), bool(e.get("strikeOff")))
        for e in entries
        if isinstance(e.get("value"), (int, float))
    ]
    if not amounts:
        return None, None
    live = [a for a, struck in amounts if not struck]
    struck = [a for a, s in amounts if s]
    price = min(live) if live else min(a for a, _ in amounts)
    mrp = max(struck) if struck else None
    return price, (mrp if mrp and mrp > price else None)


def _image(value: dict[str, Any]) -> str | None:
    """First image URL, with Flipkart's ``{@width}`` placeholders resolved."""
    images = (value.get("media") or {}).get("images") or []
    for image in images:
        url = image.get("url") if isinstance(image, dict) else None
        if not url:
            continue
        url = (
            str(url)
            .replace("{@width}", "416")
            .replace("{@height}", "416")
            .replace("{@quality}", "70")
        )
        return "https://" + url[len("http://") :] if url.startswith("http://") else url
    return None


def _size(value: dict[str, Any]) -> str | None:
    """Size, read from ``titles.coSubtitle`` ("Size: 8") or ``titles.subtitle``."""
    titles = value.get("titles") or {}
    co = titles.get("coSubtitle")
    if isinstance(co, str) and co.lower().startswith("size:"):
        return co.split(":", 1)[1].strip() or None
    subtitle = titles.get("subtitle")
    if isinstance(subtitle, str) and "," in subtitle:
        tail = subtitle.rsplit(",", 1)[1].strip()
        if tail:
            return tail
    return None


def parse_product(value: dict[str, Any], category: str) -> Offer | None:
    """Map one ``productInfo.value`` onto an :class:`Offer`."""
    price, mrp = _prices(value)
    titles = value.get("titles") or {}
    name = titles.get("title") or titles.get("newTitle")
    if price is None or not name:
        return None
    base_url = value.get("baseUrl") or ""
    intent = (value.get("buyability") or {}).get("intent")
    return Offer(
        ext_id=str(value["id"]),
        name=str(name),
        price=price,
        mrp=mrp,
        # 'positive' means buyable; 'negative' is Flipkart's sold-out marker.
        in_stock=intent != "negative",
        url=f"{BASE_URL}{base_url}" if base_url.startswith("/") else str(base_url or BASE_URL),
        category=category,
        brand=str(titles["superTitle"]) if titles.get("superTitle") else None,
        size=_size(value),
        image_url=_image(value),
    )


def parse_offers(html: str, category: str) -> list[Offer]:
    """Parse every product on a saved Flipkart search page."""
    state = extract_state(html)
    offers: list[Offer] = []
    seen: set[str] = set()
    for value in iter_product_values(state):
        offer = parse_product(value, category)
        if offer is None or offer.ext_id in seen:
            continue
        seen.add(offer.ext_id)
        offers.append(offer)
    if not offers and extract_ld_titles(html):
        raise FlipkartParseError(
            "ld+json lists products but the Redux parse found none -- layout changed"
        )
    return offers


# --------------------------------------------------------------------------
# Client-side filtering
# --------------------------------------------------------------------------


def apply_filters(offers: list[Offer], filters: Filters | None) -> list[Offer]:
    """Apply brand / size / max-price after collection.

    Flipkart's facets live behind ``/search?...&p[]=facets%5B...%5D`` tokens that
    are category specific and could not be verified under throttling, so nothing
    is pushed server side here. Unlike Amazon, size *is* usable because the
    product card carries ``titles.coSubtitle``, so ``Filters.matches`` -- the
    shared client-side fallback in ``core.types`` -- is exactly right.
    """
    if filters is None:
        return offers
    return [offer for offer in offers if filters.matches(offer)]


# --------------------------------------------------------------------------
# Adapter
# --------------------------------------------------------------------------

Fetcher = Callable[[str], Any]


def read_response(response: Any) -> tuple[int, str]:
    """Normalise a ``requests.Response`` (or a test double) to ``(status, text)``."""
    if isinstance(response, str):
        return 200, response
    if isinstance(response, bytes):
        return 200, response.decode("utf-8", "replace")
    status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(response, "status", 200)
    text = getattr(response, "text", None)
    if text is None:
        content = getattr(response, "content", b"")
        text = content.decode("utf-8", "replace") if isinstance(content, bytes) else str(content)
    return int(status), str(text)


class FlipkartAdapter(BaseAdapter):
    """Fashion adapter for flipkart.

    ``BaseAdapter`` supplies the spec section 6 boundary (never raise, log and
    return ``[]``). This adds :attr:`last_status`, so downstream can tell a
    block from a genuinely empty result -- conflating the two would write false
    stock-outs into the price history.
    """

    id: str = ADAPTER_ID
    mode: Mode = MODE

    #: Catalog slug -> Flipkart search queries. Men's only, by product decision.
    #:
    #: Same shape and same reason as the Amazon table: `/offers-store` renders
    #: no prices, so the sweep is a keyword search, and the query used to be
    #: `category_label(category)` -- the literal slug "fashion-tops".
    #:
    #: **These terms are UNVERIFIED against the live site.** Every one of the
    #: eight was attempted on 2026-09-13 and every one came back behind the
    #: reCAPTCHA wall (403), which is the documented Flipkart behaviour (§3.1)
    #: rather than anything about the queries. They mirror the Amazon set,
    #: which *is* verified at 47-48 men's products per query. Whoever first
    #: gets a clean Flipkart run should confirm them and amend this note --
    #: do not assume they work because the Amazon equivalents do.
    CATEGORY_IDS: dict[str, tuple[str, ...]] = {
        "fashion-tops": ("men's t-shirts", "men's casual shirts"),
        "fashion-bottoms": ("men's jeans", "men's trousers"),
        "fashion-footwear": ("men's casual shoes", "men's sports shoes"),
        "fashion-accessories": ("men's watches", "men's wallets"),
    }

    def __init__(self, client: HttpClient | None = None, fetch: Fetcher | None = None) -> None:
        super().__init__(client)
        self._fetch: Fetcher = fetch or (lambda url: self.client.get(url))
        self.last_status: Literal["ok", "blocked", "error", "idle"] = "idle"
        self.last_error: str | None = None

    @property
    def blocked(self) -> bool:
        return self.last_status == "blocked"

    def fetch_page(self, url: str) -> str:
        """GET ``url``, raising :class:`FlipkartBlocked` on a wall."""
        status, body = read_response(self._fetch(url))
        reason = detect_block(status, body)
        if reason is not None:
            self.last_status = "blocked"
            self.last_error = f"{url}: {reason}"
            logger.error("flipkart: BLOCKED (not empty) -- %s", self.last_error)
            raise FlipkartBlocked(self.last_error)
        return body

    def _sweep(self, category: Category, loc: Location) -> list[Offer]:
        """Price-sorted sweep of every men's query mapped to ``category``.

        ``loc`` is irrelevant here -- Flipkart prices are national.
        """
        del loc
        found: dict[str, Offer] = {}
        for query in self.sweep_terms(category):
            try:
                url = build_search_url(query, sort="price_asc")
                for offer in self._collect(url, self.stored_category(category), None):
                    found.setdefault(offer.ext_id, offer)
            except Exception:  # noqa: BLE001 - one query must not cost the others
                self.log.warning(
                    "flipkart: query %r failed, keeping %d offers so far",
                    query, len(found), exc_info=True,
                )
        return list(found.values())

    def _search(self, q: str, f: Filters, loc: Location) -> list[Offer]:
        del loc
        return self._collect(build_search_url(q), q, f)

    def _collect(self, url: str, category: str, filters: Filters | None) -> list[Offer]:
        try:
            offers = apply_filters(parse_offers(self.fetch_page(url), category), filters)
        except FlipkartBlocked:
            return []
        except Exception as exc:  # noqa: BLE001 - keep the detail BaseAdapter would lose
            self.last_status = "error"
            self.last_error = f"{type(exc).__name__}: {exc}"
            logger.exception("flipkart: parse failed for %s", url)
            return []
        self.last_status = "ok"
        self.last_error = None
        logger.info("flipkart: %s -> %d offers", url, len(offers))
        return offers
