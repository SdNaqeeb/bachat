"""Offline parser tests for the BigBasket adapter (spec sections 6 and 13).

Fixtures are trimmed captures of real responses taken on 2026-09-12 with the
location set to Koramangala, Bengaluru (560034):

* ``bigbasket_category_beverages.json`` -- ``listing-svc/v2/products?type=pc``
* ``bigbasket_category_beverages.html`` -- the ``/cl/beverages/`` page
* ``bigbasket_search_amul_milk.json``   -- ``listing-svc/v2/products?type=ps``
* ``bigbasket_header_560034.json``      -- ``/ui-svc/v2/header/`` additional_cookies
* ``bigbasket_serviceable_560034.json`` -- ``/ui-svc/v1/serviceable`` places_info

No test here touches the network.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from collectors.adapters.bigbasket import (
    API_HEADERS,
    BASE,
    BigBasketAdapter,
    decode_address_info,
    extract_next_data,
    location_cookies,
    offer_from_product,
    page_count,
    parse_category_page,
    parse_offers,
    product_info,
)
from collectors.core.types import Category, Filters, Location, Offer

FIXTURES = Path(__file__).resolve().parent / "fixtures"
API_JSON = json.loads((FIXTURES / "bigbasket_category_beverages.json").read_text(encoding="utf-8"))
PAGE_HTML = (FIXTURES / "bigbasket_category_beverages.html").read_text(encoding="utf-8")
SEARCH_JSON = json.loads((FIXTURES / "bigbasket_search_amul_milk.json").read_text(encoding="utf-8"))
HEADER_JSON = json.loads((FIXTURES / "bigbasket_header_560034.json").read_text(encoding="utf-8"))
SERVICEABLE_JSON = json.loads(
    (FIXTURES / "bigbasket_serviceable_560034.json").read_text(encoding="utf-8")
)

BEVERAGES = Category(id="beverages", slug="beverages", label="Beverages")


@pytest.fixture(scope="module")
def offers() -> list[Offer]:
    return parse_offers(API_JSON, "beverages")


# -- envelopes --------------------------------------------------------------
def test_api_and_html_envelopes_reach_the_same_product_info() -> None:
    assert product_info(API_JSON)["products"]
    assert product_info(extract_next_data(PAGE_HTML))["products"]


def test_html_page_parses_to_offers() -> None:
    html_offers = parse_category_page(PAGE_HTML, "beverages")
    assert html_offers
    assert all(o.category == "beverages" for o in html_offers)


def test_a_page_without_next_data_is_a_parse_error() -> None:
    with pytest.raises(ValueError, match="__NEXT_DATA__"):
        extract_next_data("<html><body>nope</body></html>")


def test_an_unserviceable_location_yields_no_products_rather_than_an_error() -> None:
    # BigBasket answers SSRData: null for a location it cannot serve.
    payload = {"props": {"pageProps": {"SSRData": None}}}
    assert product_info(payload) == {"products": []}
    assert parse_offers(payload, "beverages") == []


# -- offers -----------------------------------------------------------------
def test_offers_are_parsed_from_the_capture(offers: list[Offer]) -> None:
    assert offers
    assert all(isinstance(o, Offer) for o in offers)


def test_name_is_brand_plus_description(offers: list[Offer]) -> None:
    bisleri = next(o for o in offers if o.ext_id == "40211241")
    assert bisleri.brand == "Bisleri"
    assert bisleri.name.startswith("Bisleri ")
    assert "Packaged Drinking Water" in bisleri.name
    assert bisleri.size == "10 L"
    assert bisleri.price > 0


def test_selling_price_comes_from_prim_price_sp() -> None:
    product = {
        "id": "1", "desc": "Tea", "brand": {"name": "Brooke Bond"}, "w": "250 g",
        "absolute_url": "/pd/1/brooke-bond-tea-250-g/",
        "availability": {"avail_status": "001"},
        "pricing": {"discount": {"mrp": "214", "prim_price": {"sp": "213", "rsp": "214"}}},
    }
    offer = offer_from_product(product, "beverages")
    assert offer is not None
    assert offer.price == 213.0
    assert offer.mrp == 214.0


def test_rsp_is_used_when_sp_is_missing() -> None:
    product = {
        "id": "1", "desc": "Tea", "brand": {"name": "X"},
        "availability": {"avail_status": "001"},
        "pricing": {"discount": {"mrp": "100", "prim_price": {"sp": None, "rsp": "90"}}},
    }
    offer = offer_from_product(product, "beverages")
    assert offer is not None and offer.price == 90.0


def test_price_is_never_above_mrp(offers: list[Offer]) -> None:
    for offer in offers:
        if offer.mrp is not None:
            assert offer.price <= offer.mrp, offer


def test_child_pack_sizes_become_their_own_offers(offers: list[Offer]) -> None:
    parents = {str(p["id"]) for p in API_JSON["tabs"][0]["product_info"]["products"]}
    ids = {o.ext_id for o in offers}
    assert ids > parents, "children[] variants should be emitted as offers too"


def test_offers_are_deduped_by_id(offers: list[Offer]) -> None:
    ids = [o.ext_id for o in offers]
    assert len(ids) == len(set(ids))


def test_urls_are_absolute_pd_deeplinks(offers: list[Offer]) -> None:
    # Spec section 6: we deep-link to /pd/ but never *fetch* it (it 429s).
    for offer in offers:
        assert offer.url.startswith(f"{BASE}/")


def test_images_are_populated(offers: list[Offer]) -> None:
    assert all(o.image_url and o.image_url.startswith("http") for o in offers)


# -- stock ------------------------------------------------------------------
def _product(avail: str) -> dict:
    return {
        "id": "1", "desc": "Milk", "brand": {"name": "Amul"},
        "availability": {"avail_status": avail},
        "pricing": {"discount": {"mrp": "30", "prim_price": {"sp": "29"}}},
    }


@pytest.mark.parametrize(("avail", "expected"), [("001", True), ("010", False), ("", False)])
def test_avail_status_maps_to_in_stock(avail: str, expected: bool) -> None:
    offer = offer_from_product(_product(avail), "dairy")
    assert offer is not None and offer.in_stock is expected


# -- degraded input ---------------------------------------------------------
def test_a_product_without_a_price_is_skipped() -> None:
    product = _product("001")
    product["pricing"] = {"discount": {"mrp": "30"}}
    assert offer_from_product(product, "dairy") is None


def test_a_product_without_an_id_is_skipped() -> None:
    product = _product("001")
    product.pop("id")
    assert offer_from_product(product, "dairy") is None


def test_a_product_without_a_name_is_skipped() -> None:
    product = _product("001")
    product["desc"] = ""
    product["brand"] = {}
    assert offer_from_product(product, "dairy") is None


def test_a_product_with_no_brand_still_parses() -> None:
    product = _product("001")
    product["brand"] = {}
    offer = offer_from_product(product, "dairy")
    assert offer is not None and offer.brand is None and offer.name == "Milk"


def test_page_count_defaults_to_one() -> None:
    assert page_count({}) == 1
    assert page_count(API_JSON) >= 1


# -- search -----------------------------------------------------------------
def test_search_payload_parses_with_the_same_code() -> None:
    results = parse_offers(SEARCH_JSON, "search")
    assert results
    assert any("amul" in (o.brand or "").casefold() for o in results)


def test_search_filters_are_applied() -> None:
    results = parse_offers(SEARCH_JSON, "search")
    amul = [o for o in results if Filters(brands=("Amul",)).matches(o)]
    assert amul and all("amul" in (o.brand or "").casefold() for o in amul)


# -- location handshake -----------------------------------------------------
def test_location_cookies_are_read_from_additional_cookies() -> None:
    cookies = location_cookies(HEADER_JSON)
    assert cookies["_bb_pin_code"] == "560034"
    assert cookies["_bb_sa_ids"]
    assert cookies["_bb_addressinfo"]
    assert cookies["_bb_cda_sa_info"]


def test_location_cookies_of_an_empty_response_are_empty() -> None:
    assert location_cookies({}) == {}
    assert location_cookies({"additional_cookies": None}) == {}


def test_address_info_cookie_decodes_to_the_requested_pincode() -> None:
    decoded = decode_address_info(location_cookies(HEADER_JSON)["_bb_addressinfo"])
    assert decoded["pincode"] == "560034"
    assert decoded["city"] == "Bengaluru"
    assert float(decoded["lat"]) == pytest.approx(
        float(SERVICEABLE_JSON["places_info"]["lat"])
    )


def test_address_info_decoding_never_raises_on_garbage() -> None:
    assert decode_address_info("not base64 @@@") == {}


def test_preset_cookies_short_circuit_the_handshake() -> None:
    adapter = BigBasketAdapter(cookies={"_bb_pin_code": "560034", "_bb_sa_ids": "16535"})

    def _explode(loc: Location) -> dict[str, str]:  # pragma: no cover - must not run
        raise AssertionError("handshake must not run when cookies are supplied")

    adapter.resolve_location_cookies = _explode  # type: ignore[method-assign]
    adapter.ensure_location(Location(pincode="560034"))
    assert adapter.client.cookie("_bb_pin_code") == "560034"


def test_the_listing_api_always_sends_the_x_caller_header() -> None:
    # Without X-Caller: UIKIRK the listing service answers HTTP 500 / PL5012.
    assert API_HEADERS["X-Caller"] == "UIKIRK"
    headers = BigBasketAdapter()._api_headers()
    assert headers["X-Caller"] == "UIKIRK"
    assert headers["X-Entry-Context"] == "bbnow"


# -- fail-soft boundary -----------------------------------------------------
class _ExplodingAdapter(BigBasketAdapter):
    def _sweep(self, category: Category, loc: Location) -> list[Offer]:
        raise RuntimeError("bigbasket changed its schema")

    def _search(self, q: str, f: Filters, loc: Location) -> list[Offer]:
        raise RuntimeError("bigbasket changed its schema")


def test_sweep_never_raises_past_the_boundary() -> None:
    adapter = _ExplodingAdapter()
    assert adapter.sweep(BEVERAGES, Location(pincode="560034")) == []
    assert adapter.search("milk", Filters(), Location(pincode="560034")) == []
