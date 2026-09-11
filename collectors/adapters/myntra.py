"""Myntra fashion adapter.

Myntra server-renders its product listing pages and embeds the whole listing
response as a JSON blob assigned to ``window.__myx``. There is no headless
browser, no XHR replay and no auth: one plain GET with a browser User-Agent is
enough.

Crucially for Bachat, Myntra accepts brand / size / price facets **in the URL**,
so :class:`Filters` is pushed to the retailer instead of being applied after
collection (spec section 3). The same blob also carries every available facet
value, so the mobile app's filter pickers can be populated from real data rather
than a hard-coded guess.

Verified live on 2026-09-12 -- see ``FASHION-NOTES.md`` for the raw measurements.

Layering inside this module, deliberately kept separable so parsing is testable
with no network (spec section 13):

* URL building      -- :func:`build_listing_url`, :func:`build_search_url`
* Block detection   -- :func:`detect_block`
* Parsing (pure)    -- :func:`extract_myx`, :func:`parse_offers`, :func:`parse_facets`
* Fetching (I/O)    -- :class:`MyntraAdapter`
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Callable, Final, Iterable, Literal, Sequence
from urllib.parse import quote, urlencode

from collectors.adapters.base import BaseAdapter
from collectors.core.http import HttpClient
from collectors.core.types import Category, Filters, Location, Mode, Offer

logger: Final = logging.getLogger(__name__)

ADAPTER_ID: Final = "myntra"
MODE: Final[Mode] = "fashion"
BASE_URL: Final = "https://www.myntra.com"

#: Path used by :meth:`MyntraAdapter.sweep` when a category carries no slug.
SALE_PATH: Final = "sale"

#: Facet ids exactly as Myntra names them in ``filters``. Do not "tidy" these --
#: ``size_facet`` really is snake_case while ``Brand`` really is capitalised.
BRAND_FACET: Final = "Brand"
SIZE_FACET: Final = "size_facet"
COLOR_FACET: Final = "Color"
PRICE_FACET: Final = "Price"
DISCOUNT_FACET: Final = "Discount Range"

#: Anything smaller than this is an error/interstitial page, never a listing.
MIN_LISTING_BYTES: Final = 20_000

#: Myntra pages this many products per request by default.
DEFAULT_PAGE_SIZE: Final = 50

_MYX_RE: Final = re.compile(r"window\.__myx\s*=\s*(\{.*?\});?\s*</script>", re.DOTALL)

#: Interstitial markers. Every one of these was checked against a real 1.4 MB
#: Myntra listing page and is absent from it. A bare "captcha" was tried first
#: and REJECTED: the genuine page contains the substring, so it would have
#: reported every successful sweep as a block.
_BLOCK_MARKERS: Final = (
    "access denied",
    "request unsuccessful",
    "incapsula incident",
    "you have been blocked",
    "validatecaptcha",
)


class MyntraBlocked(RuntimeError):
    """Myntra refused or interstitialled the request.

    This is emphatically *not* "zero products". A block that is parsed as an
    empty result set would silently poison the price history, so every fetch
    path raises this instead of returning ``[]``.
    """


class MyntraParseError(RuntimeError):
    """A 200 that really is a Myntra page, but whose shape we no longer know."""


# --------------------------------------------------------------------------
# Facets
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class FacetValue:
    """One selectable value of a Myntra facet.

    ``id`` is the exact token that must be echoed back in the ``?f=`` query
    parameter; ``count`` is Myntra's own result count for it, which the app can
    show next to the checkbox.
    """

    id: str
    label: str
    count: int | None = None


@dataclass(frozen=True)
class PriceRange:
    """The price band Myntra reports for the current listing."""

    start: float
    end: float


@dataclass(frozen=True)
class Facets:
    """Everything the mobile filter pickers need for one category."""

    brands: tuple[FacetValue, ...] = ()
    sizes: tuple[FacetValue, ...] = ()
    colors: tuple[FacetValue, ...] = ()
    price: PriceRange | None = None

    def brand_ids(self) -> frozenset[str]:
        return frozenset(v.id for v in self.brands)

    def size_ids(self) -> frozenset[str]:
        return frozenset(v.id for v in self.sizes)


@dataclass(frozen=True)
class FilterPlan:
    """The outcome of reconciling requested :class:`Filters` with real facets.

    ``rejected`` exists so a typo'd brand is reported rather than silently
    widening the sweep to every brand on Myntra.
    """

    brands: tuple[str, ...] = ()
    sizes: tuple[str, ...] = ()
    max_price: float | None = None
    rejected: tuple[str, ...] = ()


# --------------------------------------------------------------------------
# Category handling
# --------------------------------------------------------------------------

_SLUG_CLEAN_RE: Final = re.compile(r"[^a-z0-9]+")


def category_slug(category: Category | str | None) -> str:
    """Return the Myntra URL path for ``category``.

    ``Category.id`` is the retailer-defined key (spec section 6 / core.types),
    so for Myntra it is the listing path itself -- ``"men-tshirts"``. ``slug``
    is the retailer-independent D1 key and is only a fallback here.
    """
    if category is None:
        return SALE_PATH
    if isinstance(category, str):
        raw = category
    else:
        raw = ""
        for attr in ("id", "path", "slug", "label"):
            value = getattr(category, attr, None)
            if isinstance(value, str) and value.strip():
                raw = value
                break
    raw = raw.strip().strip("/")
    if not raw:
        return SALE_PATH
    slug = _SLUG_CLEAN_RE.sub("-", raw.lower()).strip("-")
    return slug or SALE_PATH


def category_label(category: Category | str | None) -> str:
    """Value written into :attr:`Offer.category`.

    This is ``Category.slug`` -- the retailer-independent key D1 stores against
    products -- not the Myntra-specific path.
    """
    if category is None:
        return SALE_PATH
    if isinstance(category, str):
        return category
    for attr in ("slug", "id", "label"):
        value = getattr(category, attr, None)
        if isinstance(value, str) and value.strip():
            return value
    return category_slug(category)


# --------------------------------------------------------------------------
# URL building -- this is where Filters become server-side facets
# --------------------------------------------------------------------------


def build_facet_param(brands: Sequence[str] = (), sizes: Sequence[str] = ()) -> str | None:
    """Build Myntra's ``f`` parameter value.

    Verified live: ``?f=Brand:Nike``, ``?f=size_facet:M`` and the combined
    ``?f=Brand:Nike::size_facet:M`` all appear in ``appliedParams.filters``,
    i.e. Myntra really applies them server side.

    Multiple values inside one facet are comma separated; separate facets are
    joined with ``::``.
    """
    groups: list[str] = []
    if brands:
        groups.append(f"{BRAND_FACET}:{','.join(brands)}")
    if sizes:
        groups.append(f"{SIZE_FACET}:{','.join(sizes)}")
    return "::".join(groups) if groups else None


def build_range_param(max_price: float | None, *, min_price: float = 0.0) -> str | None:
    """Build Myntra's ``rf`` parameter value for a price ceiling.

    Verified live: ``rf=Price:0.0_1000.0_0.0 TO 1000.0`` comes back in
    ``appliedParams.rangeFilters`` as ``"Rs.1000 and Below"``. The odd repeated
    encoding is Myntra's own; it is reproduced rather than simplified.
    """
    if max_price is None:
        return None
    lo = float(min_price)
    hi = float(max_price)
    if hi <= lo:
        return None
    return f"{PRICE_FACET}:{lo}_{hi}_{lo} TO {hi}"


def build_listing_url(
    slug: str,
    *,
    plan: FilterPlan | None = None,
    page: int = 1,
    sort: str | None = None,
    raw_query: str | None = None,
) -> str:
    """Assemble a Myntra listing URL with all filters pushed server side."""
    params: list[tuple[str, str]] = []
    if raw_query:
        params.append(("rawQuery", raw_query))
    if plan is not None:
        facet = build_facet_param(plan.brands, plan.sizes)
        if facet:
            params.append(("f", facet))
        rf = build_range_param(plan.max_price)
        if rf:
            params.append(("rf", rf))
    if sort:
        params.append(("sort", sort))
    if page > 1:
        params.append(("p", str(page)))
    url = f"{BASE_URL}/{slug.strip('/')}"
    if params:
        # ``:``, ``,`` and ``_`` are structural in Myntra's facet grammar and
        # must survive unescaped; spaces must become %20 (Myntra rejects ``+``
        # inside ``rf``).
        url = f"{url}?{urlencode(params, quote_via=quote, safe=':,_')}"
    return url


def build_search_url(query: str, *, plan: FilterPlan | None = None, page: int = 1) -> str:
    """Myntra search is a listing page whose slug is the query.

    Verified live: ``/running-shoes?rawQuery=running%20shoes`` -> 200 with
    ``totalCount`` 18757 and a normal ``__myx`` blob.
    """
    slug = _SLUG_CLEAN_RE.sub("-", query.strip().lower()).strip("-") or SALE_PATH
    return build_listing_url(slug, plan=plan, page=page, raw_query=query.strip())


# --------------------------------------------------------------------------
# Block detection
# --------------------------------------------------------------------------


def detect_block(status_code: int, body: str) -> str | None:
    """Return a human-readable block reason, or ``None`` if the body looks real.

    Signals, in order of confidence:

    1. a known interstitial marker (checked first: a wall can be served at 200);
    2. presence of a ``__myx`` blob, which positively proves a real page;
    3. a non-200 status;
    4. a body far too small to be a 1.3 MB listing page.
    """
    lowered = body[:200_000].lower()
    for marker in _BLOCK_MARKERS:
        if marker in lowered:
            return f"interstitial marker {marker!r} (http {status_code})"
    # A real ``__myx`` blob is proof of a real page, whatever its size -- which
    # also lets the trimmed offline fixture travel the full adapter path.
    if _MYX_RE.search(body) is not None:
        return None
    if status_code != 200:
        return f"http {status_code}"
    if len(body) < MIN_LISTING_BYTES:
        return f"body too small ({len(body)} bytes, expected >= {MIN_LISTING_BYTES})"
    return "no window.__myx blob in a 200 response"


# --------------------------------------------------------------------------
# Parsing -- pure functions over a saved page, no network
# --------------------------------------------------------------------------


def extract_myx(html: str) -> dict[str, Any]:
    """Pull the ``window.__myx`` JSON object out of a listing page."""
    match = _MYX_RE.search(html)
    if match is None:
        raise MyntraParseError("window.__myx blob not found")
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError as exc:  # pragma: no cover - shape change
        raise MyntraParseError(f"window.__myx is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise MyntraParseError("window.__myx is not an object")
    return payload


def _results(myx: dict[str, Any]) -> dict[str, Any]:
    results = (myx.get("searchData") or {}).get("results")
    if not isinstance(results, dict):
        raise MyntraParseError("searchData.results missing")
    return results


def total_count(myx: dict[str, Any]) -> int:
    """Myntra's own count of matching products for the applied filters."""
    value = _results(myx).get("totalCount")
    return int(value) if isinstance(value, (int, float)) else 0


def applied_filters(myx: dict[str, Any]) -> dict[str, list[str]]:
    """Read back the filters Myntra says it applied.

    Used by the live smoke check to prove the ``?f=`` push actually landed
    rather than being ignored.
    """
    applied = _results(myx).get("appliedParams") or {}
    out: dict[str, list[str]] = {}
    for entry in applied.get("filters") or []:
        if isinstance(entry, dict) and entry.get("id"):
            out[str(entry["id"])] = [str(v) for v in entry.get("values") or []]
    for entry in applied.get("rangeFilters") or []:
        if isinstance(entry, dict) and entry.get("id"):
            out[str(entry["id"])] = [
                str(v.get("id")) for v in entry.get("values") or [] if isinstance(v, dict)
            ]
    return out


def _https(url: str | None) -> str | None:
    if not url:
        return None
    return "https://" + url[len("http://") :] if url.startswith("http://") else url


def _sizes_of(product: dict[str, Any]) -> str | None:
    """Available sizes as a comma-joined string.

    ``sizes`` is the full offered range ("XXS,XS,S,M,L,XL,XXL,3XL").
    ``inventoryInfo`` lists the actually-stocked SKUs and, when a ``size_facet``
    filter is pushed, narrows to the requested size -- so it wins when present.
    """
    inventory = product.get("inventoryInfo")
    if isinstance(inventory, list):
        labels = [
            str(entry.get("label"))
            for entry in inventory
            if isinstance(entry, dict) and entry.get("label") and entry.get("available", True)
        ]
        if labels:
            return ",".join(dict.fromkeys(labels))
    sizes = product.get("sizes")
    return str(sizes) if isinstance(sizes, str) and sizes else None


def _in_stock(product: dict[str, Any]) -> bool:
    inventory = product.get("inventoryInfo")
    if isinstance(inventory, list) and inventory:
        return any(
            isinstance(entry, dict)
            and (entry.get("available") is True or (entry.get("inventory") or 0) > 0)
            for entry in inventory
        )
    # No inventory block at all: Myntra only lists buyable styles on a PLP, so
    # a positive price is the honest fallback rather than inventing a stock-out.
    return bool(product.get("price"))


def parse_product(product: dict[str, Any], category: str) -> Offer | None:
    """Map one ``searchData.results.products[]`` entry onto an :class:`Offer`."""
    ext_id = product.get("productId")
    price = product.get("price")
    if ext_id is None or not isinstance(price, (int, float)):
        return None
    name = product.get("productName") or product.get("product")
    if not name:
        return None
    mrp = product.get("mrp")
    landing = product.get("landingPageUrl") or ""
    return Offer(
        ext_id=str(ext_id),
        name=str(name),
        price=float(price),
        mrp=float(mrp) if isinstance(mrp, (int, float)) and mrp else None,
        in_stock=_in_stock(product),
        url=f"{BASE_URL}/{str(landing).lstrip('/')}" if landing else f"{BASE_URL}/{ext_id}",
        category=category,
        brand=str(product["brand"]) if product.get("brand") else None,
        size=_sizes_of(product),
        image_url=_https(product.get("searchImage")),
    )


def parse_offers(myx: dict[str, Any], category: str) -> list[Offer]:
    """All parseable offers on the page.

    Sponsored placements (``plaProducts``) are deliberately ignored: they are
    ad inventory, not the organic listing, and would skew the price history.
    """
    products = _results(myx).get("products")
    if not isinstance(products, list):
        raise MyntraParseError("searchData.results.products missing")
    offers: list[Offer] = []
    for product in products:
        if not isinstance(product, dict):
            continue
        offer = parse_product(product, category)
        if offer is not None:
            offers.append(offer)
    return offers


def _facet_groups(myx: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Index every facet group by its ``id``.

    Myntra repeats the same facet in several presentation buckets
    (``primaryFilters``, ``inlineFilters``, ...). They are merged here and the
    richest copy of each id wins.
    """
    filters = _results(myx).get("filters")
    if not isinstance(filters, dict):
        return {}
    merged: dict[str, list[dict[str, Any]]] = {}
    for bucket in (
        "primaryFilters",
        "inlineFilters",
        "secondaryFilters",
        "rangeFilters",
        "pillsFilters",
        "collapsiblePillsFilters",
    ):
        for group in filters.get(bucket) or []:
            if not isinstance(group, dict):
                continue
            gid = group.get("id")
            values = group.get("filterValues")
            if not gid or not isinstance(values, list):
                continue
            existing = merged.get(str(gid))
            if existing is None or len(values) > len(existing):
                merged[str(gid)] = [v for v in values if isinstance(v, dict)]
    return merged


def _facet_values(values: Iterable[dict[str, Any]]) -> tuple[FacetValue, ...]:
    out: list[FacetValue] = []
    for value in values:
        vid = value.get("id")
        if vid is None:
            continue
        count = value.get("count")
        out.append(
            FacetValue(
                id=str(vid),
                label=str(value.get("value") or vid),
                count=int(count) if isinstance(count, (int, float)) else None,
            )
        )
    return tuple(out)


def parse_facets(myx: dict[str, Any]) -> Facets:
    """Enumerate the real brand / size / colour / price facets for a page.

    This is what makes the app's filter pickers truthful: the values offered to
    the user are exactly the tokens Myntra will accept back in ``?f=``.
    """
    groups = _facet_groups(myx)
    price: PriceRange | None = None
    for value in groups.get(PRICE_FACET, ()):
        start, end = value.get("start"), value.get("end")
        if isinstance(start, (int, float)) and isinstance(end, (int, float)):
            price = (
                PriceRange(float(start), float(end))
                if price is None
                else PriceRange(min(price.start, float(start)), max(price.end, float(end)))
            )
    return Facets(
        brands=_facet_values(groups.get(BRAND_FACET, ())),
        sizes=_facet_values(groups.get(SIZE_FACET, ())),
        colors=_facet_values(groups.get(COLOR_FACET, ())),
        price=price,
    )


# --------------------------------------------------------------------------
# Filters -> FilterPlan
# --------------------------------------------------------------------------


def _requested(filters: Filters | None, attr: str) -> list[str]:
    values = getattr(filters, attr, None) if filters is not None else None
    if not values:
        return []
    return [str(v).strip() for v in values if str(v).strip()]


def plan_filters(filters: Filters | None, facets: Facets | None = None) -> FilterPlan:
    """Reconcile requested filters against the facets Myntra actually offers.

    With ``facets`` supplied, values are matched case-insensitively against real
    facet ids and unknown values land in :attr:`FilterPlan.rejected` so they can
    be logged. Without facets the request is passed through unchanged -- Myntra
    simply returns zero results for a bogus token, which is a safe failure.
    """
    brands = _requested(filters, "brands")
    sizes = _requested(filters, "sizes")
    max_price = getattr(filters, "max_price", None) if filters is not None else None

    if facets is None:
        return FilterPlan(
            brands=tuple(brands),
            sizes=tuple(sizes),
            max_price=float(max_price) if max_price else None,
        )

    def resolve(requested: list[str], available: tuple[FacetValue, ...]) -> tuple[list[str], list[str]]:
        index = {v.id.casefold(): v.id for v in available}
        ok: list[str] = []
        bad: list[str] = []
        for value in requested:
            real = index.get(value.casefold())
            (ok if real else bad).append(real or value)
        return ok, bad

    good_brands, bad_brands = resolve(brands, facets.brands)
    good_sizes, bad_sizes = resolve(sizes, facets.sizes)
    return FilterPlan(
        brands=tuple(good_brands),
        sizes=tuple(good_sizes),
        max_price=float(max_price) if max_price else None,
        rejected=tuple(bad_brands + bad_sizes),
    )


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


class MyntraAdapter(BaseAdapter):
    """Fashion adapter for myntra.com.

    ``BaseAdapter`` supplies the spec section 6 boundary: ``sweep``/``search``
    never raise, they log and return ``[]``. On top of that this records
    :attr:`last_status`, so a *block* is distinguishable from a genuinely empty
    result -- the two must never be conflated in the price history.
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
        """True when the last call failed because Myntra refused us."""
        return self.last_status == "blocked"

    # -- fetching ---------------------------------------------------------

    def fetch_page(self, url: str) -> dict[str, Any]:
        """GET ``url`` and return its ``__myx`` blob, or raise :class:`MyntraBlocked`."""
        status, body = read_response(self._fetch(url))
        reason = detect_block(status, body)
        if reason is not None:
            self.last_status = "blocked"
            self.last_error = f"{url}: {reason}"
            logger.error("myntra: BLOCKED (not empty) -- %s", self.last_error)
            raise MyntraBlocked(self.last_error)
        return extract_myx(body)

    # -- facet enumeration ------------------------------------------------

    def facets(self, category: Category | str) -> Facets:
        """Enumerate the real brand/size/colour facets for ``category``.

        Feeds the mobile filter pickers. Fails soft to empty facets so a block
        degrades the UI instead of breaking the sweep.
        """
        try:
            return parse_facets(self.fetch_page(build_listing_url(category_slug(category))))
        except MyntraBlocked:
            return Facets()
        except Exception as exc:  # noqa: BLE001 - boundary
            self._record_error(exc)
            return Facets()

    # -- BaseAdapter hooks ------------------------------------------------

    def _sweep(self, category: Category, loc: Location) -> list[Offer]:
        """Collect the discount-sorted listing for ``category``.

        ``loc`` is accepted for protocol conformance and ignored: Myntra prices
        are national, not dark-store specific.
        """
        del loc
        url = build_listing_url(category_slug(category), sort="discount")
        return self._collect(url, category_label(category))

    def _search(self, q: str, f: Filters, loc: Location) -> list[Offer]:
        """Search ``q`` with ``f`` pushed into the URL as server-side facets.

        Facets are enumerated first so requested brands/sizes are validated
        against the tokens Myntra actually accepts; an unknown value is logged
        rather than silently widening the search.
        """
        del loc
        try:
            facets = parse_facets(self.fetch_page(build_search_url(q)))
        except MyntraBlocked:
            return []
        except Exception as exc:  # noqa: BLE001 - boundary
            self._record_error(exc)
            facets = Facets()

        plan = plan_filters(f, facets if (facets.brands or facets.sizes) else None)
        if plan.rejected:
            logger.warning("myntra: dropping filter values Myntra does not offer: %s", plan.rejected)
        return self._collect(build_search_url(q, plan=plan), q)

    # -- internals --------------------------------------------------------

    def _collect(self, url: str, category: str) -> list[Offer]:
        try:
            offers = parse_offers(self.fetch_page(url), category)
        except MyntraBlocked:
            return []
        except Exception as exc:  # noqa: BLE001 - BaseAdapter would swallow the detail
            self._record_error(exc)
            return []
        self.last_status = "ok"
        self.last_error = None
        logger.info("myntra: %s -> %d offers", url, len(offers))
        return offers

    def _record_error(self, exc: Exception) -> None:
        self.last_status = "error"
        self.last_error = f"{type(exc).__name__}: {exc}"
        logger.exception("myntra: parse failed")
