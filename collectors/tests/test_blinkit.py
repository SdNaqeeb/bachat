"""Offline parser tests for the Blinkit adapter (spec sections 6 and 13).

Everything here runs against ``fixtures/blinkit_category_munchies.html`` and
``fixtures/blinkit_search_amul_milk.json``, both trimmed captures of real
responses taken on 2026-09-12. No test in this file touches the network -- the
autouse ``no_network`` fixture in ``conftest.py`` makes that a hard failure
rather than a promise.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from collectors.adapters.base import to_float
from collectors.adapters.blinkit import (
    BASE,
    BlinkitAdapter,
    extract_state,
    iter_product_cards,
    merchant_id,
    next_page_url,
    offer_from_card,
    parse_category_page,
    parse_offers,
    product_url,
)
from collectors.core.types import Category, Filters, Location, Offer

FIXTURES = Path(__file__).resolve().parent / "fixtures"
CATEGORY_HTML = (FIXTURES / "blinkit_category_munchies.html").read_text(encoding="utf-8")
SEARCH_JSON = json.loads((FIXTURES / "blinkit_search_amul_milk.json").read_text(encoding="utf-8"))

MUNCHIES = Category(id="munchies/cid/1237/940", slug="snacks", label="Munchies")


@pytest.fixture(scope="module")
def state() -> dict:
    return extract_state(CATEGORY_HTML)


@pytest.fixture(scope="module")
def offers() -> list[Offer]:
    return parse_category_page(CATEGORY_HTML, "snacks")


# -- envelope ---------------------------------------------------------------
def test_state_is_extracted_from_the_script_tag(state: dict) -> None:
    assert "ui" in state
    assert state["ui"]["plpContainer"]["feedData"]["snippets"]


def test_trailing_javascript_after_the_state_object_is_ignored(state: dict) -> None:
    # The real page continues `;window.grofers.ENV = {...}` on the same line,
    # so a naive "read to the last brace" parser would choke here.
    assert "window.grofers.ENV" in CATEGORY_HTML
    assert isinstance(state, dict)


def test_a_page_without_the_state_is_a_parse_error() -> None:
    with pytest.raises(ValueError, match="PRELOADED_STATE"):
        extract_state("<html><body>nope</body></html>")


def test_cards_are_found_including_nested_variants(state: dict) -> None:
    top_level = state["ui"]["plpContainer"]["feedData"]["snippets"]
    all_cards = list(iter_product_cards(state))
    assert len(all_cards) > len(top_level), "variant_list cards should be picked up too"


# -- offers -----------------------------------------------------------------
def test_offers_are_parsed_from_the_captured_page(offers: list[Offer]) -> None:
    assert offers
    assert all(isinstance(o, Offer) for o in offers)


def test_offers_are_deduped_by_product_id(offers: list[Offer]) -> None:
    ids = [o.ext_id for o in offers]
    assert len(ids) == len(set(ids))


def test_price_and_mrp_come_from_tracking_as_numbers(offers: list[Offer]) -> None:
    known = {o.ext_id: o for o in offers}
    banana = known["807617"]
    assert banana.name == "Beyond Snack Vibe Long Banana Chips (Masala Mingle)"
    assert banana.price == 39.0
    assert banana.mrp == 50.0
    assert banana.brand == "Beyond Snack"
    assert banana.size == "50 g"


def test_price_is_never_above_mrp(offers: list[Offer]) -> None:
    for offer in offers:
        if offer.mrp is not None:
            assert offer.price <= offer.mrp, offer


def test_every_offer_carries_the_requested_category_slug(offers: list[Offer]) -> None:
    assert {o.category for o in offers} == {"snacks"}


def test_urls_are_web_pdp_links_not_app_deeplinks(offers: list[Offer]) -> None:
    for offer in offers:
        assert offer.url.startswith(f"{BASE}/prn/")
        assert offer.url.endswith(f"/prid/{offer.ext_id}")
        assert "grofers://" not in offer.url


def test_product_url_slugifies_the_name() -> None:
    url = product_url("807617", "Beyond Snack Vibe Long Banana Chips (Masala Mingle)")
    assert url == (
        f"{BASE}/prn/beyond-snack-vibe-long-banana-chips-masala-mingle/prid/807617"
    )


def test_product_url_survives_a_name_with_no_usable_characters() -> None:
    assert product_url("1", "!!!") == f"{BASE}/prn/p/prid/1"


def test_images_are_populated(offers: list[Offer]) -> None:
    assert all(o.image_url and o.image_url.startswith("http") for o in offers)


# -- stock ------------------------------------------------------------------
def _card(**overrides: object) -> dict:
    data = {
        "product_id": "1",
        "display_name": {"text": "Test Product"},
        "normal_price": {"text": "₹39"},
        "mrp": {"text": "₹50"},
        "variant": {"text": "50 g"},
        "is_sold_out": False,
        "product_state": "available",
    }
    data.update(overrides)
    return {
        "widget_type": "product_card_snippet_type_2",
        "data": data,
        "tracking": {"common_attributes": {"price": 39, "mrp": 50, "inventory": 3,
                                           "name": "Test Product", "brand": "Test"}},
    }


def test_sold_out_flag_marks_the_offer_out_of_stock() -> None:
    offer = offer_from_card(_card(is_sold_out=True), "snacks")
    assert offer is not None and offer.in_stock is False


def test_non_available_product_state_marks_the_offer_out_of_stock() -> None:
    offer = offer_from_card(_card(product_state="unavailable"), "snacks")
    assert offer is not None and offer.in_stock is False


def test_zero_inventory_marks_the_offer_out_of_stock() -> None:
    card = _card()
    card["tracking"]["common_attributes"]["inventory"] = 0
    offer = offer_from_card(card, "snacks")
    assert offer is not None and offer.in_stock is False


def test_an_available_card_is_in_stock() -> None:
    offer = offer_from_card(_card(), "snacks")
    assert offer is not None and offer.in_stock is True


# -- degraded input ---------------------------------------------------------
def test_a_card_without_a_price_is_skipped() -> None:
    card = _card()
    card["data"].pop("normal_price")
    card["tracking"]["common_attributes"].pop("price")
    assert offer_from_card(card, "snacks") is None


def test_a_card_without_a_product_id_is_skipped() -> None:
    card = _card()
    card["data"].pop("product_id")
    assert offer_from_card(card, "snacks") is None


def test_a_card_without_a_name_is_skipped() -> None:
    card = _card()
    card["data"].pop("display_name")
    card["tracking"]["common_attributes"].pop("name")
    assert offer_from_card(card, "snacks") is None


def test_display_price_strings_are_used_when_tracking_is_missing() -> None:
    card = _card()
    card["tracking"] = {}
    offer = offer_from_card(card, "snacks")
    assert offer is not None
    assert offer.price == 39.0
    assert offer.mrp == 50.0


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("₹39", 39.0), ("1,299", 1299.0), (39, 39.0), (39.5, 39.5), ("", None), (None, None),
     ("n/a", None), (True, None)],
)
def test_to_float(raw: object, expected: float | None) -> None:
    assert to_float(raw) == expected


def test_an_empty_payload_yields_no_offers() -> None:
    assert parse_offers({}, "snacks") == []


# -- pagination and location ------------------------------------------------
def test_next_page_url_is_absolutised(state: dict) -> None:
    url = next_page_url(state)
    assert url is not None
    assert url.startswith(f"{BASE}/v1/layout/listing_widgets?")
    assert "l0_cat=1237" in url and "l1_cat=940" in url


def test_next_page_url_is_none_without_pagination() -> None:
    assert next_page_url({"ui": {"plpContainer": {"feedData": {"snippets": []}}}}) is None


def test_merchant_id_identifies_the_serving_dark_store(state: dict) -> None:
    assert merchant_id(state) == "31719"


def test_location_headers_are_lat_lon() -> None:
    adapter = BlinkitAdapter()
    headers = adapter.location_headers(Location(lat=12.9261382, lon=77.6221091))
    assert headers == {"lat": "12.9261382", "lon": "77.6221091"}


def test_location_headers_are_empty_without_coordinates() -> None:
    assert BlinkitAdapter().location_headers(Location(pincode="560034")) == {}


def test_category_url_is_built_from_the_retailer_id() -> None:
    adapter = BlinkitAdapter()
    assert adapter.category_url(MUNCHIES) == f"{BASE}/cn/munchies/cid/1237/940"


# -- search -----------------------------------------------------------------
def test_search_payload_parses_with_the_same_code() -> None:
    offers = parse_offers(SEARCH_JSON, "search")
    assert offers
    assert all(o.category == "search" for o in offers)
    assert all(o.price > 0 for o in offers)


def test_filters_are_applied_to_search_results() -> None:
    offers = parse_offers(SEARCH_JSON, "search")
    cheapest = min(o.price for o in offers)
    kept = [o for o in offers if Filters(max_price=cheapest).matches(o)]
    assert kept and all(o.price <= cheapest for o in kept)


# -- fail-soft boundary -----------------------------------------------------
class _ExplodingAdapter(BlinkitAdapter):
    def _sweep(self, category: Category, loc: Location) -> list[Offer]:
        raise RuntimeError("blinkit changed its markup")

    def _search(self, q: str, f: Filters, loc: Location) -> list[Offer]:
        raise RuntimeError("blinkit changed its markup")


def test_sweep_never_raises_past_the_boundary() -> None:
    adapter = _ExplodingAdapter()
    assert adapter.sweep(MUNCHIES, Location(lat=1.0, lon=2.0)) == []
    assert adapter.search("milk", Filters(), Location()) == []
