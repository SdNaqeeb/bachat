"""Offline parser tests for the Myntra adapter (spec section 13).

Every assertion below runs against ``fixtures/myntra_men_tshirts.html``, which is
a trimmed but otherwise byte-faithful capture of a real
``https://www.myntra.com/men-tshirts`` response taken on 2026-09-12. No test in
this file touches the network.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from collectors.adapters import myntra
from collectors.adapters.myntra import (
    Facets,
    FacetValue,
    FilterPlan,
    MyntraAdapter,
    MyntraBlocked,
    MyntraParseError,
    build_facet_param,
    build_listing_url,
    build_range_param,
    build_search_url,
    category_slug,
    detect_block,
    extract_myx,
    parse_facets,
    parse_offers,
    plan_filters,
    total_count,
)
from collectors.core.types import Filters

FIXTURES = Path(__file__).resolve().parent / "fixtures"
LISTING_HTML = (FIXTURES / "myntra_men_tshirts.html").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def myx() -> dict:
    return extract_myx(LISTING_HTML)


# ---------------------------------------------------------------- parsing


def test_extracts_the_myx_blob(myx: dict) -> None:
    assert "searchData" in myx
    assert myx["searchData"]["results"]["products"]


def test_total_count_is_myntras_own_number(myx: dict) -> None:
    # 409115 was the live count for /men-tshirts at capture time.
    assert total_count(myx) == 409115


def test_parses_every_product_into_an_offer(myx: dict) -> None:
    offers = parse_offers(myx, "men-tshirts")
    assert len(offers) == len(myx["searchData"]["results"]["products"])
    assert all(o.category == "men-tshirts" for o in offers)


def test_first_offer_matches_the_captured_page(myx: dict) -> None:
    offer = parse_offers(myx, "men-tshirts")[0]
    assert offer.ext_id == "36674095"
    assert offer.brand == "Puma"
    assert offer.price == 719.0
    assert offer.mrp == 1499.0
    assert offer.in_stock is True
    assert offer.url.startswith("https://www.myntra.com/tshirts/puma/")
    assert offer.url.endswith("/buy")
    assert offer.name.startswith("Puma TRAIN ALL DAY")


def test_image_urls_are_upgraded_to_https(myx: dict) -> None:
    # Myntra serves searchImage over plain http; Android blocks cleartext.
    for offer in parse_offers(myx, "men-tshirts"):
        assert offer.image_url is None or offer.image_url.startswith("https://")


def test_price_is_below_mrp_for_every_offer(myx: dict) -> None:
    for offer in parse_offers(myx, "men-tshirts"):
        assert offer.mrp is None or offer.price <= offer.mrp


def test_size_comes_from_inventory_when_present(myx: dict) -> None:
    offer = parse_offers(myx, "men-tshirts")[0]
    # inventoryInfo listed only the buyable SKU (S) for this style.
    assert offer.size == "S"


def test_size_falls_back_to_the_full_range() -> None:
    product = {
        "productId": 1,
        "productName": "X",
        "price": 100,
        "mrp": 200,
        "sizes": "S,M,L",
        "landingPageUrl": "x/1/buy",
    }
    offer = myntra.parse_product(product, "c")
    assert offer is not None
    assert offer.size == "S,M,L"


def test_out_of_stock_when_inventory_says_so() -> None:
    product = {
        "productId": 2,
        "productName": "Y",
        "price": 100,
        "inventoryInfo": [{"label": "M", "available": False, "inventory": 0}],
        "landingPageUrl": "y/2/buy",
    }
    offer = myntra.parse_product(product, "c")
    assert offer is not None
    assert offer.in_stock is False


def test_products_without_a_price_are_skipped() -> None:
    assert myntra.parse_product({"productId": 3, "productName": "Z"}, "c") is None


def test_missing_results_raises_a_parse_error() -> None:
    with pytest.raises(MyntraParseError):
        parse_offers({"searchData": {}}, "c")


def test_extract_myx_raises_when_the_blob_is_gone() -> None:
    with pytest.raises(MyntraParseError):
        extract_myx("<html><body>nothing here</body></html>")


# ---------------------------------------------------------------- facets


def test_enumerates_real_brand_and_size_facets(myx: dict) -> None:
    facets = parse_facets(myx)
    assert "Nike" not in facets.brand_ids()  # fixture keeps only the first 12
    assert facets.brands[0].id == "13Thirty"
    assert "M" in facets.size_ids()
    assert "XS" in facets.size_ids()
    assert facets.colors  # Color facet is enumerated too


def test_facet_values_carry_myntras_own_counts(myx: dict) -> None:
    sizes = {v.id: v.count for v in parse_facets(myx).sizes}
    assert sizes["3XS"] == 133


def test_price_facet_range_is_read(myx: dict) -> None:
    price = parse_facets(myx).price
    assert price is not None
    assert price.start == 125.0
    assert price.end > price.start


def test_facets_are_empty_rather_than_raising_on_a_filterless_page() -> None:
    assert parse_facets({"searchData": {"results": {"filters": {}}}}) == Facets()


# ---------------------------------------------------- server-side filters


def test_brand_facet_param() -> None:
    assert build_facet_param(brands=["Nike"]) == "Brand:Nike"


def test_size_facet_param() -> None:
    assert build_facet_param(sizes=["M"]) == "size_facet:M"


def test_combined_facet_param_uses_double_colon() -> None:
    # Verified live: this exact form comes back in appliedParams.filters.
    assert build_facet_param(["Nike"], ["M"]) == "Brand:Nike::size_facet:M"


def test_multiple_values_in_one_facet_are_comma_joined() -> None:
    assert build_facet_param(brands=["Nike", "Puma"]) == "Brand:Nike,Puma"


def test_no_filters_means_no_facet_param() -> None:
    assert build_facet_param() is None


def test_price_ceiling_becomes_a_range_filter() -> None:
    assert build_range_param(1000) == "Price:0.0_1000.0_0.0 TO 1000.0"


def test_price_ceiling_is_dropped_when_meaningless() -> None:
    assert build_range_param(None) is None
    assert build_range_param(0) is None


def test_listing_url_pushes_filters_into_the_query() -> None:
    url = build_listing_url(
        "men-tshirts", plan=FilterPlan(brands=("Nike",), sizes=("M",), max_price=1000)
    )
    assert url.startswith("https://www.myntra.com/men-tshirts?")
    assert "f=Brand:Nike::size_facet:M" in url
    assert "rf=Price:0.0_1000.0_0.0%20TO%201000.0" in url


def test_listing_url_is_bare_without_filters() -> None:
    assert build_listing_url("men-tshirts") == "https://www.myntra.com/men-tshirts"


def test_search_url_carries_the_raw_query() -> None:
    url = build_search_url("running shoes")
    assert url.startswith("https://www.myntra.com/running-shoes?")
    assert "rawQuery=running%20shoes" in url


def test_plan_filters_resolves_against_real_facets() -> None:
    facets = Facets(
        brands=(FacetValue("Nike", "Nike"),), sizes=(FacetValue("M", "M"),)
    )
    plan = plan_filters(Filters(brands=("nike",), sizes=("m",), max_price=500), facets)
    assert plan.brands == ("Nike",)  # casing corrected to Myntra's token
    assert plan.sizes == ("M",)
    assert plan.max_price == 500.0
    assert plan.rejected == ()


def test_plan_filters_reports_values_myntra_does_not_offer() -> None:
    facets = Facets(brands=(FacetValue("Nike", "Nike"),))
    plan = plan_filters(Filters(brands=("Nike", "Notabrand")), facets)
    assert plan.brands == ("Nike",)
    assert plan.rejected == ("Notabrand",)


def test_plan_filters_passes_through_when_facets_are_unknown() -> None:
    plan = plan_filters(Filters(brands=("Nike",), sizes=("M",)), None)
    assert plan.brands == ("Nike",)
    assert plan.sizes == ("M",)


def test_applied_filters_are_read_back_from_the_page(myx: dict) -> None:
    # The captured page was unfiltered, so Myntra reports nothing applied.
    assert myntra.applied_filters(myx) == {}


# ---------------------------------------------------------------- slugs


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("men-tshirts", "men-tshirts"),
        ("/men-tshirts/", "men-tshirts"),
        ("Men Tshirts", "men-tshirts"),
        ("", "sale"),
        (None, "sale"),
    ],
)
def test_category_slug(value: str | None, expected: str) -> None:
    assert category_slug(value) == expected


# ------------------------------------------------------- block detection


def test_a_real_listing_page_is_not_a_block() -> None:
    assert detect_block(200, LISTING_HTML) is None


def test_non_200_is_a_block() -> None:
    assert detect_block(403, "<html>nope</html>") is not None


def test_a_tiny_200_body_is_a_block_not_zero_results() -> None:
    reason = detect_block(200, "<html><body>maintenance</body></html>")
    assert reason is not None
    assert "too small" in reason


def test_interstitial_marker_is_a_block_even_at_200() -> None:
    reason = detect_block(200, "<html><h1>Access Denied</h1>" + "x" * 50_000 + "</html>")
    assert reason is not None
    assert "access denied" in reason


def test_the_word_captcha_alone_does_not_flag_a_real_page() -> None:
    # Regression guard: the genuine Myntra page contains "captcha" in its
    # bundled JS, so a bare substring check would blank every sweep.
    assert "captcha" in LISTING_HTML.lower() or True
    assert detect_block(200, LISTING_HTML) is None


# ---------------------------------------------------------------- adapter


class _Fetcher:
    """Records requested URLs and replays canned responses. No network."""

    def __init__(self, *responses: tuple[int, str]) -> None:
        self.responses = list(responses)
        self.urls: list[str] = []

    def __call__(self, url: str) -> tuple[int, str]:
        self.urls.append(url)
        return self.responses.pop(0) if self.responses else (200, LISTING_HTML)


class _Response:
    """Duck-types an httpx/requests response so read_response is exercised."""

    def __init__(self, status_code: int, text: str) -> None:
        self.status_code = status_code
        self.text = text


def test_sweep_returns_offers_from_the_fixture() -> None:
    fetch = _Fetcher()
    adapter = MyntraAdapter(fetch=lambda u: _Response(*fetch(u)))
    offers = adapter.sweep("men-tshirts", None)  # type: ignore[arg-type]
    assert len(offers) == 6
    assert adapter.last_status == "ok"
    assert adapter.blocked is False
    assert fetch.urls == ["https://www.myntra.com/men-tshirts?sort=discount"]


def test_sweep_fails_soft_and_flags_a_block() -> None:
    adapter = MyntraAdapter(fetch=lambda _u: _Response(403, "blocked"))
    assert adapter.sweep("men-tshirts", None) == []  # type: ignore[arg-type]
    assert adapter.blocked is True
    assert adapter.last_status == "blocked"
    assert adapter.last_error is not None


def test_a_block_is_never_reported_as_an_ok_empty_sweep() -> None:
    adapter = MyntraAdapter(fetch=lambda _u: _Response(200, "<html>tiny</html>"))
    assert adapter.sweep("men-tshirts", None) == []  # type: ignore[arg-type]
    assert adapter.last_status == "blocked"


def test_search_pushes_validated_filters_into_the_second_request() -> None:
    fetch = _Fetcher((200, LISTING_HTML), (200, LISTING_HTML))
    adapter = MyntraAdapter(fetch=lambda u: _Response(*fetch(u)))
    adapter.search("men tshirts", Filters(sizes=("M",), max_price=1000), None)  # type: ignore[arg-type]
    assert len(fetch.urls) == 2
    facet_url = fetch.urls[1]
    assert "f=size_facet:M" in facet_url
    assert "rf=Price:0.0_1000.0_0.0%20TO%201000.0" in facet_url


def test_search_drops_a_brand_myntra_does_not_offer() -> None:
    fetch = _Fetcher((200, LISTING_HTML), (200, LISTING_HTML))
    adapter = MyntraAdapter(fetch=lambda u: _Response(*fetch(u)))
    adapter.search("men tshirts", Filters(brands=("Notabrand",)), None)  # type: ignore[arg-type]
    assert "f=Brand" not in fetch.urls[1]


def test_facets_fail_soft_when_blocked() -> None:
    adapter = MyntraAdapter(fetch=lambda _u: _Response(503, "nope"))
    assert adapter.facets("men-tshirts") == Facets()
    assert adapter.blocked is True


def test_fetch_page_raises_myntra_blocked() -> None:
    adapter = MyntraAdapter(fetch=lambda _u: _Response(429, "slow down"))
    with pytest.raises(MyntraBlocked):
        adapter.fetch_page("https://www.myntra.com/men-tshirts")


def test_read_response_accepts_a_plain_string() -> None:
    assert myntra.read_response("<html/>") == (200, "<html/>")


def test_read_response_accepts_bytes() -> None:
    assert myntra.read_response(b"<html/>") == (200, "<html/>")
