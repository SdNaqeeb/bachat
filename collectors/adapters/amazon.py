"""Amazon.in fashion adapter.

Amazon serves ``/s?k=<query>`` as plain server-rendered HTML with no usable JSON
island, so this parses the DOM with selectolax (fast, pure C, no lxml build).
There is no API path: PA-API 5.0 is deprecated and sunsets around May 2026, and
the affiliate programme is not available to a single-user personal tool.

The important behaviour here is **block detection**. Amazon answers automated
traffic with a 503 "rush hour" page carrying an ``api-services-support@amazon.com``
comment, or with a ``/errors/validateCaptcha`` interstitial. Both are ~1-3 KB and
contain zero product cards -- exactly indistinguishable from "no results" unless
you look for them on purpose. Reporting a block as an empty result set would
write false stock-outs into the price history, so every block raises
:class:`AmazonBlocked`.

Verified live on 2026-09-12 -- see ``FASHION-NOTES.md``.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable, Final, Literal
from urllib.parse import urlencode

from selectolax.parser import HTMLParser, Node

from collectors.adapters.base import BaseAdapter
from collectors.core.http import HttpClient
from collectors.core.types import Category, Filters, Location, Mode, Offer

logger: Final = logging.getLogger(__name__)

ADAPTER_ID: Final = "amazon"
MODE: Final[Mode] = "fashion"
BASE_URL: Final = "https://www.amazon.in"

#: A real ``/s`` results page measured at 2.8 MB. The 503 wall is 1.3 KB and the
#: captcha interstitial a few KB, so this threshold separates them cleanly.
MIN_RESULTS_BYTES: Final = 100_000

#: Amazon paces hard. One request every ~8 s kept a session alive through the
#: whole probe run; going faster earned an immediate 503.
DEFAULT_DELAY_SECONDS: Final = 8.0

_RESULT_CARD_SELECTOR: Final = 'div[data-asin][data-component-type="s-search-result"]'
_TITLE_BLOCK: Final = '[data-cy="title-recipe"]'
_RESULT_CARD_MARKER: Final = 'data-component-type="s-search-result"'

#: Amazon prefixes sponsored placements' accessible labels with this.
_SPONSORED_PREFIX: Final = "Sponsored Ad - "

#: Substrings that positively identify an Amazon bot wall. The first is the
#: HTML comment Amazon embeds in its 503 page; the rest cover the captcha forms.
_BLOCK_MARKERS: Final = (
    "api-services-support@amazon.com",
    "/errors/validateCaptcha",
    "captcha/",
    "Enter the characters you see below",
    "Type the characters you see in this image",
    "To discuss automated access to Amazon data",
)

_OUT_OF_STOCK_MARKERS: Final = (
    "currently unavailable",
    "out of stock",
    "temporarily out of stock",
)

_ASIN_RE: Final = re.compile(r"^[A-Z0-9]{10}$")
_MONEY_RE: Final = re.compile(r"[\d][\d,]*(?:\.\d+)?")


class AmazonBlocked(RuntimeError):
    """Amazon served a bot wall. Never to be confused with zero results."""


class AmazonParseError(RuntimeError):
    """A results page whose DOM no longer matches what we parse."""


# --------------------------------------------------------------------------
# URL building
# --------------------------------------------------------------------------


def build_search_url(query: str, *, page: int = 1, sort: str | None = None) -> str:
    """Assemble an Amazon.in search URL.

    Amazon has no brand/size facet token we can synthesise reliably from a free
    text value (``rh=p_89:<Brand>`` needs Amazon's own canonical casing), so
    :class:`Filters` for this retailer are applied after collection -- see
    :func:`apply_filters`. That is stated plainly rather than faked.
    """
    params: list[tuple[str, str]] = [("k", query.strip())]
    if sort:
        params.append(("s", sort))
    if page > 1:
        params.append(("page", str(page)))
    return f"{BASE_URL}/s?{urlencode(params)}"


def build_category_url(category: Category | str, *, page: int = 1) -> str:
    """Sweep URL for a category.

    Amazon's ``/deals`` page is a React shell with no server-rendered offers, so
    the sweep is a keyword search sorted by discount instead. This is honest:
    it is what actually returns parseable prices.
    """
    return build_search_url(category_label(category), page=page, sort="discount-rank")


def category_label(category: Category | str | None) -> str:
    """Best available human/slug label for ``category``."""
    if category is None:
        return "deals"
    if isinstance(category, str):
        return category
    for attr in ("slug", "id", "label"):
        value = getattr(category, attr, None)
        if isinstance(value, str) and value.strip():
            return value
    return str(category)


# --------------------------------------------------------------------------
# Block detection
# --------------------------------------------------------------------------


def detect_block(status_code: int, body: str) -> str | None:
    """Return a block reason, or ``None`` if this looks like a real SERP.

    Order matters: the marker check runs before the size check so a captcha page
    is reported as a captcha rather than as "suspiciously small".
    """
    head = body[:400_000]
    # 1. A positive wall marker wins outright, whatever the status code.
    for marker in _BLOCK_MARKERS:
        if marker in head:
            return f"bot wall marker {marker!r} (http {status_code})"
    # 2. Real result cards positively prove a real SERP, whatever the size --
    #    which also lets the trimmed offline fixture travel the adapter path.
    if _RESULT_CARD_MARKER in body:
        return None
    if status_code == 503:
        return "http 503 service-unavailable wall"
    if status_code != 200:
        return f"http {status_code}"
    if len(body) < MIN_RESULTS_BYTES:
        return f"body too small ({len(body)} bytes, expected >= {MIN_RESULTS_BYTES})"
    return "no s-search-result cards in a 200 response"


# --------------------------------------------------------------------------
# Parsing -- pure functions over saved HTML
# --------------------------------------------------------------------------


def _text(node: Node | None) -> str | None:
    if node is None:
        return None
    value = node.text(strip=True)
    return value or None


def parse_money(value: str | None) -> float | None:
    """``'Rs.1,999.00'`` -> ``1999.0``. Returns ``None`` for anything unparseable."""
    if not value:
        return None
    match = _MONEY_RE.search(value)
    if match is None:
        return None
    try:
        return float(match.group(0).replace(",", ""))
    except ValueError:  # pragma: no cover - regex already guarantees digits
        return None


def _price_of(card: Node) -> float | None:
    """Current selling price.

    ``span.a-price`` without ``a-text-price`` is the live price; its
    ``span.a-offscreen`` child is the screen-reader copy and carries the full
    value including paise, which ``a-price-whole`` truncates.
    """
    for node in card.css("span.a-price"):
        classes = node.attributes.get("class") or ""
        if "a-text-price" in classes:
            continue
        price = parse_money(_text(node.css_first("span.a-offscreen")))
        if price is not None:
            return price
    whole = _text(card.css_first("span.a-price-whole"))
    return parse_money(whole)


def _mrp_of(card: Node) -> float | None:
    """Struck-through M.R.P., rendered as ``span.a-price.a-text-price``."""
    node = card.css_first("span.a-price.a-text-price span.a-offscreen")
    return parse_money(_text(node))


def _title_of(card: Node) -> str | None:
    """Full product title.

    Amazon's current SERP puts the *brand* in the first ``h2`` and the product
    title in a second ``h2`` inside the result link, with the untruncated text
    on its ``aria-label``.
    """
    link_heading = card.css_first(f"{_TITLE_BLOCK} a h2")
    if link_heading is not None:
        aria = link_heading.attributes.get("aria-label")
        if aria:
            return _clean_title(aria)
        text = _text(link_heading)
        if text:
            return _clean_title(text)
    image = card.css_first("img.s-image")
    if image is not None:
        alt = image.attributes.get("alt")
        if alt:
            return _clean_title(alt)
    return _clean_title(_text(card.css_first("h2")))


def _clean_title(value: str | None) -> str | None:
    """Drop Amazon's accessibility-only "Sponsored Ad - " prefix."""
    if not value:
        return None
    text = value.strip()
    if text.startswith(_SPONSORED_PREFIX):
        text = text[len(_SPONSORED_PREFIX) :].strip()
    return text or None


def _brand_of(card: Node) -> str | None:
    """Brand, from the first ``h2`` of the title block (``h2.a-size-mini``)."""
    node = card.css_first(f"{_TITLE_BLOCK} h2.a-size-mini span") or card.css_first(
        f"{_TITLE_BLOCK} div.a-row h2 span"
    )
    brand = _text(node)
    if brand and len(brand) <= 60:
        return brand
    return None


def _in_stock(card: Node) -> bool:
    """Stock, read from the availability copy Amazon renders in red.

    "Only 2 left in stock" is *in* stock; "Currently unavailable" is not.
    """
    for node in card.css("span.a-color-price, span.a-color-error"):
        text = (node.text(strip=True) or "").casefold()
        if any(marker in text for marker in _OUT_OF_STOCK_MARKERS):
            return False
    return True


def _sponsored(card: Node) -> bool:
    if card.css_first('[data-component-type="s-impression-logger"]') is not None:
        return True
    image = card.css_first("img.s-image")
    alt = (image.attributes.get("alt") or "") if image is not None else ""
    return alt.startswith("Sponsored Ad")


def parse_card(card: Node, category: str) -> Offer | None:
    """Map one ``s-search-result`` div onto an :class:`Offer`.

    Returns ``None`` for cards with no ASIN, no title or no price -- Amazon
    interleaves banners, "results for a related search" rows and video shelves
    into the same slot.
    """
    asin = (card.attributes.get("data-asin") or "").strip()
    if not _ASIN_RE.match(asin):
        return None
    price = _price_of(card)
    title = _title_of(card)
    if price is None or not title:
        return None
    mrp = _mrp_of(card)
    image = card.css_first("img.s-image")
    return Offer(
        ext_id=asin,
        name=title,
        price=price,
        mrp=mrp if mrp and mrp > price else None,
        in_stock=_in_stock(card),
        # Built from the ASIN rather than the href: sponsored results link
        # through /sspa/click with a tracking blob that rots within hours.
        url=f"{BASE_URL}/dp/{asin}",
        category=category,
        brand=_brand_of(card),
        size=None,  # Amazon's SERP carries no size; it lives on the detail page.
        image_url=(image.attributes.get("src") if image is not None else None) or None,
    )


def parse_offers(html: str, category: str, *, include_sponsored: bool = False) -> list[Offer]:
    """Parse every organic result card on a saved Amazon SERP.

    Sponsored placements are excluded by default -- they are ad inventory whose
    price is not the retailer's standing price for the category sweep.
    """
    tree = HTMLParser(html)
    cards = tree.css(_RESULT_CARD_SELECTOR)
    if not cards:
        raise AmazonParseError(f"no {_RESULT_CARD_SELECTOR} nodes found")
    offers: list[Offer] = []
    seen: set[str] = set()
    for card in cards:
        if not include_sponsored and _sponsored(card):
            continue
        offer = parse_card(card, category)
        if offer is None or offer.ext_id in seen:
            continue
        seen.add(offer.ext_id)
        offers.append(offer)
    return offers


def count_result_cards(html: str) -> int:
    """Number of result slots on the page, sponsored included.

    Useful in the live smoke check: a page with cards but zero parsed offers is
    a markup change, while a page with no cards at all is a block.
    """
    return len(HTMLParser(html).css(_RESULT_CARD_SELECTOR))


# --------------------------------------------------------------------------
# Client-side filtering (Amazon has no facet push we can trust)
# --------------------------------------------------------------------------


def apply_filters(offers: list[Offer], filters: Filters | None) -> list[Offer]:
    """Apply brand / max-price filters after collection.

    Size is ignored on purpose: Amazon search cards carry no size, so filtering
    on it here would silently discard everything. That limitation is surfaced in
    ``FASHION-NOTES.md`` rather than papered over.
    """
    if filters is None:
        return offers
    brands = [str(b).casefold() for b in (getattr(filters, "brands", None) or [])]
    max_price = getattr(filters, "max_price", None)
    result = offers
    if brands:
        result = [
            o
            for o in result
            if (o.brand or "").casefold() in brands
            or any(b in o.name.casefold() for b in brands)
        ]
    if max_price:
        result = [o for o in result if o.price <= float(max_price)]
    return result


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


class AmazonAdapter(BaseAdapter):
    """Fashion adapter for amazon.

    ``BaseAdapter`` supplies the spec section 6 boundary (never raise, log and
    return ``[]``). This adds :attr:`last_status`, so downstream can tell a
    block from a genuinely empty result -- conflating the two would write false
    stock-outs into the price history.
    """

    id: str = ADAPTER_ID
    mode: Mode = MODE

    def __init__(self, client: HttpClient | None = None, fetch: Fetcher | None = None) -> None:
        super().__init__(client)
        self._fetch: Fetcher = fetch or (lambda url: self.client.get(url))
        self.last_status: Literal["ok", "blocked", "error", "idle"] = "idle"
        self.last_error: str | None = None

    @property
    def blocked(self) -> bool:
        return self.last_status == "blocked"

    def fetch_page(self, url: str) -> str:
        """GET ``url``, raising :class:`AmazonBlocked` on a wall."""
        status, body = read_response(self._fetch(url))
        reason = detect_block(status, body)
        if reason is not None:
            self.last_status = "blocked"
            self.last_error = f"{url}: {reason}"
            logger.error("amazon: BLOCKED (not empty) -- %s", self.last_error)
            raise AmazonBlocked(self.last_error)
        return body

    def _sweep(self, category: Category, loc: Location) -> list[Offer]:
        """Discount/price-sorted sweep of one category. ``loc`` is irrelevant here."""
        del loc
        return self._collect(build_category_url(category), category_label(category), None)

    def _search(self, q: str, f: Filters, loc: Location) -> list[Offer]:
        del loc
        return self._collect(build_search_url(q), q, f)

    def _collect(self, url: str, category: str, filters: Filters | None) -> list[Offer]:
        try:
            offers = apply_filters(parse_offers(self.fetch_page(url), category), filters)
        except AmazonBlocked:
            return []
        except Exception as exc:  # noqa: BLE001 - keep the detail BaseAdapter would lose
            self.last_status = "error"
            self.last_error = f"{type(exc).__name__}: {exc}"
            logger.exception("amazon: parse failed for %s", url)
            return []
        self.last_status = "ok"
        self.last_error = None
        logger.info("amazon: %s -> %d offers", url, len(offers))
        return offers
