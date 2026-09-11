"""BigBasket (quick commerce, ``bbnow`` entry context).

Measured 2026-09-12 from this machine with a plain HTTP client and a desktop
Chrome UA. Two ways in, both verified:

1. ``GET /cl/<slug>/`` -- 200, ~2-3 MB of HTML with one
   ``<script id="__NEXT_DATA__">`` blob. Products at
   ``props.pageProps.SSRData.tabs[0].product_info.products`` (48 per page,
   ``?page=N`` for more).
2. ``GET /listing-svc/v2/products?type=pc&slug=<slug>&page=N`` -- the same
   product schema as JSON, ~840 KB instead of 3 MB, and ``type=ps&slug=<query>``
   gives search. **This endpoint 500s with ``PL5012`` unless the request carries
   ``X-Caller: UIKIRK``** (plus ``X-Channel: BB-WEB``); that one header is the
   whole difference. It is the default path here, with the HTML page as the
   fallback, because it is a quarter of the bytes for the same data.

Spec section 6 rule, confirmed: ``/pd/<id>/`` product-detail pages 429
immediately. Nothing here fetches one -- ``absolute_url`` is recorded as the
deep link only.

Price fields per product::

    pricing.discount.mrp                  MRP            "108"
    pricing.discount.prim_price.sp        selling price  "108"
    pricing.discount.prim_price.rsp       regular sp
    availability.avail_status             "001" in stock / "010" notify-me
    brand.name / desc / w / images[0].l / absolute_url

``children[]`` are the other pack sizes of the same product, each a full
product record with its own id and price, so they are emitted as offers too.

Location -- the handshake spec section 6 left outstanding. Solved; it is four
calls, all unauthenticated:

    1. ``GET /places/v1/places/autocomplete/?inputText=<pincode>&token=<uuid4>``
       -> ``predictions[0].placeId``
    2. ``GET /places/v1/places/details/?placeId=..&token=<uuid4>&xArm=0&yArm=0``
       -> ``geometry.location.{lat,lng}``
    3. ``GET /ui-svc/v1/serviceable?lat=..&lng=..&send_all_serviceability=true``
       -> ``places_info`` (area, pincode, city) and per-context serviceability.
       Sets the ``csurftoken`` cookie the next call needs.
    4. ``PUT /member-svc/v2/member/current-delivery-address/`` with
       ``{area, contact_zipcode, lat, long, return_hub_cookies: false}``
       then ``GET /ui-svc/v2/header/?send_door_info=true``, whose
       ``additional_cookies`` object *is* the answer: ``_bb_pin_code``,
       ``_bb_sa_ids``, ``_bb_addressinfo``, ``_bb_cda_sa_info``. Setting those
       on the session changes the catalogue and the prices (Koramangala 560034
       and Chembur 400001 return different totals and different prices for the
       same SKU; ``_bb_cid`` moves 1 -> 4 -> 18 for BLR/Mumbai/Delhi).

Setting ``_bb_pin_code`` by hand does **not** work: the server rewrites it and
``_bb_locSrc`` back to ``default`` on the next page load. The handshake is
required. ``resolve_location_cookies`` performs it; ``cookies=`` on the
constructor accepts a pre-captured set as a fallback.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from collectors.adapters.base import BaseAdapter, to_float
from collectors.core.http import HttpClient
from collectors.core.types import Category, Filters, Location, Offer

BASE = "https://www.bigbasket.com"
COOKIE_DOMAIN = ".bigbasket.com"

#: Without X-Caller the listing service answers PL5012 "2 exceptions occurred".
API_HEADERS: dict[str, str] = {
    "X-Caller": "UIKIRK",
    "X-Channel": "BB-WEB",
    "common-client-static-version": "101",
    "Accept": "application/json",
}

#: Quick-commerce entry context. Matches the xentrycontext / xentrycontextid
#: cookies BigBasket itself sets on a first visit.
ENTRY_CONTEXT = "bbnow"
ENTRY_CONTEXT_ID = "10"

AVAIL_IN_STOCK = "001"

_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.DOTALL
)


# --------------------------------------------------------------------------
# parsing (pure; no network, exercised by tests against saved fixtures)
# --------------------------------------------------------------------------
def extract_next_data(html: str) -> dict[str, Any]:
    """Pull the ``__NEXT_DATA__`` blob out of a ``/cl/<slug>/`` page."""
    match = _NEXT_DATA_RE.search(html)
    if match is None:
        raise ValueError("bigbasket: __NEXT_DATA__ not found in page")
    data = json.loads(match.group(1))
    if not isinstance(data, dict):
        raise ValueError("bigbasket: __NEXT_DATA__ was not an object")
    return data


def product_info(payload: Any) -> dict[str, Any]:
    """``tabs[0].product_info`` from either envelope, or an empty stand-in.

    A location BigBasket cannot serve returns ``SSRData: null`` rather than an
    error, so this normalises that to "no products" instead of raising.
    """
    node: Any = payload
    if isinstance(node, dict) and "props" in node:
        node = ((node.get("props") or {}).get("pageProps") or {}).get("SSRData")
    if not isinstance(node, dict):
        return {"products": []}
    tabs = node.get("tabs")
    if not isinstance(tabs, list) or not tabs:
        return {"products": []}
    info = (tabs[0] or {}).get("product_info")
    return info if isinstance(info, dict) else {"products": []}


def offer_from_product(product: dict[str, Any], category_slug: str) -> Offer | None:
    """Build an ``Offer`` from one BigBasket product record."""
    ext_id = str(product.get("id") or "").strip()
    if not ext_id:
        return None

    discount = ((product.get("pricing") or {}).get("discount")) or {}
    price = to_float((discount.get("prim_price") or {}).get("sp"))
    if price is None:
        price = to_float((discount.get("prim_price") or {}).get("rsp"))
    if price is None:
        return None
    mrp = to_float(discount.get("mrp"))

    brand = ((product.get("brand") or {}).get("name") or "").strip()
    desc = str(product.get("desc") or "").strip()
    name = f"{brand} {desc}".strip() if brand else desc
    if not name:
        return None

    availability = product.get("availability") or {}
    in_stock = str(availability.get("avail_status") or "") == AVAIL_IN_STOCK

    images = product.get("images")
    image_url = None
    if isinstance(images, list) and images:
        first = images[0] or {}
        image_url = first.get("l") or first.get("m") or first.get("s")

    absolute_url = str(product.get("absolute_url") or "")
    url = absolute_url if absolute_url.startswith("http") else BASE + absolute_url

    return Offer(
        ext_id=ext_id,
        name=name,
        price=price,
        mrp=mrp,
        in_stock=in_stock,
        url=url,
        category=category_slug,
        brand=brand or None,
        size=str(product.get("w") or "").strip() or None,
        image_url=str(image_url) if image_url else None,
    )


def parse_offers(payload: Any, category_slug: str) -> list[Offer]:
    """Offers from either envelope, including every ``children[]`` pack size."""
    offers: dict[str, Offer] = {}
    for product in product_info(payload).get("products") or []:
        if not isinstance(product, dict):
            continue
        for record in (product, *[c for c in (product.get("children") or []) if isinstance(c, dict)]):
            offer = offer_from_product(record, category_slug)
            if offer is not None:
                offers.setdefault(offer.ext_id, offer)
    return list(offers.values())


def parse_category_page(html: str, category_slug: str) -> list[Offer]:
    """Offers from a saved ``/cl/<slug>/`` page. The offline HTML entry point."""
    return parse_offers(extract_next_data(html), category_slug)


def page_count(payload: Any) -> int:
    value = product_info(payload).get("number_of_pages")
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return 1


def location_cookies(header_response: dict[str, Any]) -> dict[str, str]:
    """The ``additional_cookies`` map from ``/ui-svc/v2/header/``.

    This is the output of the pincode handshake: apply it to the session and
    every later catalogue request is priced for that pincode.
    """
    cookies = header_response.get("additional_cookies")
    if not isinstance(cookies, dict):
        return {}
    return {str(k): "" if v is None else str(v) for k, v in cookies.items()}


def decode_address_info(value: str) -> dict[str, str]:
    """Decode ``_bb_addressinfo`` -- base64 of pipe-separated address fields.

    Diagnostic only; nothing in the sweep depends on it. Observed shape:
    ``lat|lng|area|pincode|city|<n>|false|true|true|Bigbasketeer``.
    """
    import base64

    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4)).decode("utf-8")
    except Exception:  # noqa: BLE001 - diagnostics must never break a sweep
        return {}
    parts = raw.split("|")
    keys = ("lat", "lng", "area", "pincode", "city")
    return {k: parts[i] for i, k in enumerate(keys) if i < len(parts)}


# --------------------------------------------------------------------------
# adapter (network)
# --------------------------------------------------------------------------
class BigBasketAdapter(BaseAdapter):
    id = "bigbasket"
    mode = "quick"

    #: Category pages to sweep per category. The listing API returns 20
    #: products per page (the HTML page returns 48), plus children.
    pages: int = 3
    #: Prefer the JSON listing service over the 3 MB HTML page.
    use_api: bool = True

    def __init__(
        self,
        client: HttpClient | None = None,
        *,
        cookies: dict[str, str] | None = None,
    ) -> None:
        super().__init__(client)
        #: Pre-supplied location cookies, used as-is when the live handshake
        #: cannot run (offline, or BigBasket changes the flow).
        self.preset_cookies = dict(cookies or {})
        self._located_pincode: str | None = None

    # -- location --------------------------------------------------------
    def _api_headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            **API_HEADERS,
            "Content-Type": "application/json",
            "X-Entry-Context": self.client.cookie("xentrycontext") or ENTRY_CONTEXT,
            "X-Entry-Context-Id": self.client.cookie("xentrycontextid") or ENTRY_CONTEXT_ID,
            "X-CSRFToken": self.client.cookie("csrftoken"),
            "X-csurftoken": self.client.cookie("csurftoken"),
            "X-Tracker": str(uuid.uuid4()),
            "Referer": f"{BASE}/",
        }
        if extra:
            headers.update(extra)
        return {k: v for k, v in headers.items() if v != ""}

    def geocode_pincode(self, pincode: str) -> tuple[float, float]:
        """Pincode -> lat/lng via BigBasket's own Places proxy (step 1 and 2)."""
        token = str(uuid.uuid4())
        response = self.client.get(
            f"{BASE}/places/v1/places/autocomplete/",
            params={"inputText": pincode, "token": token},
            headers=self._api_headers(),
        )
        response.raise_for_status()
        predictions = response.json().get("predictions") or []
        if not predictions:
            raise ValueError(f"bigbasket: no place found for pincode {pincode!r}")
        place_id = predictions[0]["placeId"]

        token = str(uuid.uuid4())
        details = self.client.get(
            f"{BASE}/places/v1/places/details/",
            params={"placeId": place_id, "token": token, "xArm": 0, "yArm": 0},
            headers=self._api_headers(
                {"xArmour": "0", "yArmour": "0", "X-Tracker": f"bwb-{token}"}
            ),
        )
        details.raise_for_status()
        point = details.json()["geometry"]["location"]
        return float(point["lat"]), float(point["lng"])

    def resolve_location_cookies(self, loc: Location) -> dict[str, str]:
        """Run the full pincode/lat-lon -> cookie handshake. Returns cookies."""
        if loc.has_coords:
            lat, lng = float(loc.lat), float(loc.lon)  # type: ignore[arg-type]
        elif loc.pincode:
            lat, lng = self.geocode_pincode(loc.pincode)
        else:
            return {}

        serviceable = self.client.get(
            f"{BASE}/ui-svc/v1/serviceable",
            params={"lat": lat, "lng": lng, "send_all_serviceability": "true"},
            headers=self._api_headers(),
        )
        serviceable.raise_for_status()
        info = serviceable.json()
        places = info.get("places_info") or {}
        if not places:
            raise ValueError(f"bigbasket: location {lat},{lng} returned no places_info")

        body = {
            "area": places.get("area"),
            "contact_zipcode": places.get("pincode"),
            "lat": float(places.get("lat", lat)),
            "long": float(places.get("lng", lng)),
            "return_hub_cookies": False,
        }
        put = self.client.put(
            f"{BASE}/member-svc/v2/member/current-delivery-address/",
            headers=self._api_headers(),
            data=json.dumps(body),
        )
        put.raise_for_status()

        header = self.client.get(
            f"{BASE}/ui-svc/v2/header/",
            params={"send_door_info": "true"},
            headers=self._api_headers(),
        )
        header.raise_for_status()
        return location_cookies(header.json())

    def ensure_location(self, loc: Location) -> None:
        """Apply location cookies to the session once per pincode."""
        key = loc.pincode or (f"{loc.lat},{loc.lon}" if loc.has_coords else "")
        if self._located_pincode == key:
            return

        self.client.set_cookies(
            {"xentrycontext": ENTRY_CONTEXT, "xentrycontextid": ENTRY_CONTEXT_ID},
            COOKIE_DOMAIN,
        )
        if self.preset_cookies:
            self.client.set_cookies(self.preset_cookies, COOKIE_DOMAIN)
            self._located_pincode = key
            return
        if not key:
            self._located_pincode = key
            return

        # Seed csrftoken / session cookies the way a browser would.
        self.client.get(f"{BASE}/")
        cookies = self.resolve_location_cookies(loc)
        if not cookies:
            raise ValueError(f"bigbasket: location handshake returned no cookies for {key}")
        self.client.set_cookies(cookies, COOKIE_DOMAIN)
        self._located_pincode = key

    # -- sweep / search --------------------------------------------------
    def _listing(self, kind: str, slug: str, page: int) -> dict[str, Any]:
        response = self.client.get(
            f"{BASE}/listing-svc/v2/products",
            params={"type": kind, "slug": slug, "page": page},
            headers=self._api_headers({"Referer": f"{BASE}/cl/{slug}/"}),
        )
        response.raise_for_status()
        return response.json()

    def _category_html(self, slug: str, page: int) -> str:
        response = self.client.get(
            f"{BASE}/cl/{slug}/", params={"page": page} if page > 1 else None
        )
        response.raise_for_status()
        return response.text

    def _sweep(self, category: Category, loc: Location) -> list[Offer]:
        self.ensure_location(loc)
        found: dict[str, Offer] = {}
        total_pages = self.pages

        for page in range(1, self.pages + 1):
            if page > total_pages:
                break
            try:
                if self.use_api:
                    payload: Any = self._listing("pc", category.id, page)
                else:
                    payload = extract_next_data(self._category_html(category.id, page))
            except Exception:  # noqa: BLE001
                # A later page failing must not throw away the earlier ones:
                # BigBasket starts 429-ing part-way through a deep sweep, and
                # three quarters of a category is worth far more than nothing.
                self.log.warning(
                    "bigbasket: %s page %d failed, keeping %d offers so far",
                    category.slug, page, len(found), exc_info=True,
                )
                break
            total_pages = min(self.pages, page_count(payload))
            offers = parse_offers(payload, category.slug)
            if not offers:
                break
            for offer in offers:
                found.setdefault(offer.ext_id, offer)

        return list(found.values())

    def _search(self, q: str, f: Filters, loc: Location) -> list[Offer]:
        self.ensure_location(loc)
        payload = self._listing("ps", q, 1)
        return [o for o in parse_offers(payload, "search") if f.matches(o)]
