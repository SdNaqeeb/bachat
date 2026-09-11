"""Offline parser tests for the Amazon.in adapter (spec section 13).

Fixtures are real captures from 2026-09-12:

* ``amazon_running_shoes.html`` -- a trimmed ``/s?k=running+shoes`` SERP
  (60 result cards reduced to 6: 2 sponsored, 4 organic).
* ``amazon_block_503.html`` -- the verbatim 1283-byte bot wall Amazon served on
  the very first unwarmed request.

No test in this file touches the network.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from collectors.adapters import amazon
from collectors.adapters.amazon import (
    AmazonAdapter,
    AmazonBlocked,
    AmazonParseError,
    apply_filters,
    build_category_url,
    build_search_url,
    count_result_cards,
    detect_block,
    parse_money,
    parse_offers,
)
from collectors.core.types import Filters

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SERP_HTML = (FIXTURES / "amazon_running_shoes.html").read_text(encoding="utf-8")
BLOCK_HTML = (FIXTURES / "amazon_block_503.html").read_text(encoding="utf-8")


# ---------------------------------------------------------------- parsing


def test_finds_every_result_card() -> None:
    assert count_result_cards(SERP_HTML) == 6


def test_sponsored_placements_are_excluded_by_default() -> None:
    assert len(parse_offers(SERP_HTML, "running shoes")) == 4


def test_sponsored_placements_can_be_included() -> None:
    assert len(parse_offers(SERP_HTML, "running shoes", include_sponsored=True)) == 6


def test_offers_match_the_captured_page() -> None:
    by_asin = {o.ext_id: o for o in parse_offers(SERP_HTML, "running shoes")}
    offer = by_asin["B01N54ZM9W"]
    assert offer.brand == "ASIAN"
    assert offer.price == 599.0
    assert offer.mrp == 999.0
    assert offer.in_stock is True
    assert offer.category == "running shoes"
    assert offer.name.startswith("Wonder-13 Men's Running Shoe")


def test_urls_are_canonical_dp_links_not_tracking_redirects() -> None:
    for offer in parse_offers(SERP_HTML, "running shoes", include_sponsored=True):
        assert offer.url == f"https://www.amazon.in/dp/{offer.ext_id}"
        assert "/sspa/click" not in offer.url


def test_sponsored_prefix_is_stripped_from_titles() -> None:
    for offer in parse_offers(SERP_HTML, "running shoes", include_sponsored=True):
        assert not offer.name.startswith("Sponsored Ad")


def test_every_offer_has_a_price_below_its_mrp() -> None:
    for offer in parse_offers(SERP_HTML, "running shoes", include_sponsored=True):
        assert offer.price > 0
        assert offer.mrp is None or offer.mrp > offer.price


def test_images_are_populated() -> None:
    for offer in parse_offers(SERP_HTML, "running shoes"):
        assert offer.image_url is not None
        assert offer.image_url.startswith("https://m.media-amazon.com/")


def test_size_is_none_because_the_serp_does_not_carry_it() -> None:
    # Documented limitation, not an oversight: Amazon size lives on the detail
    # page only. See FASHION-NOTES.md.
    assert all(o.size is None for o in parse_offers(SERP_HTML, "running shoes"))


def test_only_n_left_in_stock_still_counts_as_in_stock() -> None:
    # The fixture keeps a sponsored card carrying "Only 1 left in stock."
    assert "left in stock" in SERP_HTML
    assert all(o.in_stock for o in parse_offers(SERP_HTML, "x", include_sponsored=True))


def test_currently_unavailable_is_out_of_stock() -> None:
    card = (
        '<div data-asin="B000000001" data-component-type="s-search-result">'
        '<div data-cy="title-recipe"><a><h2 aria-label="Widget"><span>Widget</span></h2></a></div>'
        '<span class="a-price"><span class="a-offscreen">₹100</span></span>'
        '<span class="a-color-price">Currently unavailable.</span>'
        "</div>"
    )
    offer = parse_offers(card, "c")[0]
    assert offer.in_stock is False


def test_cards_without_a_price_are_skipped() -> None:
    card = (
        '<div data-asin="B000000002" data-component-type="s-search-result">'
        '<div data-cy="title-recipe"><a><h2 aria-label="No price"><span>No price</span></h2></a></div>'
        "</div>"
    )
    assert parse_offers(card, "c") == []


def test_cards_without_a_valid_asin_are_skipped() -> None:
    card = (
        '<div data-asin="" data-component-type="s-search-result">'
        '<span class="a-price"><span class="a-offscreen">₹100</span></span>'
        "</div>"
    )
    assert parse_offers(card, "c") == []


def test_a_page_with_no_cards_at_all_is_a_parse_error() -> None:
    with pytest.raises(AmazonParseError):
        parse_offers("<html><body>nothing</body></html>", "c")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("₹1,999", 1999.0),
        ("₹1,999.50", 1999.5),
        ("599", 599.0),
        ("", None),
        (None, None),
        ("no digits here", None),
    ],
)
def test_parse_money(raw: str | None, expected: float | None) -> None:
    assert parse_money(raw) == expected


# ------------------------------------------------------- block detection


def test_the_real_503_wall_is_detected_as_a_block() -> None:
    reason = detect_block(503, BLOCK_HTML)
    assert reason is not None
    assert "api-services-support@amazon.com" in reason


def test_a_block_is_never_mistaken_for_an_empty_serp() -> None:
    # The wall has zero result cards, so without detect_block it would parse as
    # "no products found" and write a false stock-out into the price history.
    assert count_result_cards(BLOCK_HTML) == 0
    assert detect_block(503, BLOCK_HTML) is not None


def test_a_real_serp_is_not_a_block() -> None:
    assert detect_block(200, SERP_HTML) is None


def test_captcha_interstitial_is_a_block() -> None:
    body = '<html><form action="/errors/validateCaptcha">' + "x" * 200 + "</form></html>"
    reason = detect_block(200, body)
    assert reason is not None
    assert "validateCaptcha" in reason


def test_small_200_without_cards_is_a_block() -> None:
    reason = detect_block(200, "<html><body>hello</body></html>")
    assert reason is not None
    assert "too small" in reason


def test_non_200_without_cards_is_a_block() -> None:
    assert detect_block(429, "<html>slow down</html>") is not None


# ---------------------------------------------------------------- urls


def test_search_url() -> None:
    assert build_search_url("running shoes") == "https://www.amazon.in/s?k=running+shoes"


def test_search_url_paginates() -> None:
    assert build_search_url("shoes", page=3).endswith("&page=3")


def test_category_sweep_url_sorts_by_discount() -> None:
    assert "s=discount-rank" in build_category_url("running shoes")


# --------------------------------------------------- client-side filters


def test_brand_filter_matches_the_brand_field() -> None:
    offers = parse_offers(SERP_HTML, "running shoes")
    filtered = apply_filters(offers, Filters(brands=("campus",)))
    assert filtered
    assert {o.brand for o in filtered} == {"Campus"}


def test_max_price_filter() -> None:
    offers = parse_offers(SERP_HTML, "running shoes")
    filtered = apply_filters(offers, Filters(max_price=700))
    assert filtered
    assert all(o.price <= 700 for o in filtered)


def test_size_filter_is_ignored_rather_than_wiping_the_result() -> None:
    # Amazon SERP cards have no size, so honouring a size filter here would
    # discard everything. The limitation is documented, not silently applied.
    offers = parse_offers(SERP_HTML, "running shoes")
    assert apply_filters(offers, Filters(sizes=("9",))) == offers


def test_no_filters_is_a_passthrough() -> None:
    offers = parse_offers(SERP_HTML, "running shoes")
    assert apply_filters(offers, None) is offers


# ---------------------------------------------------------------- adapter


class _Response:
    def __init__(self, status_code: int, text: str) -> None:
        self.status_code = status_code
        self.text = text


def test_search_returns_offers_from_the_fixture() -> None:
    urls: list[str] = []

    def fetch(url: str) -> _Response:
        urls.append(url)
        return _Response(200, SERP_HTML)

    adapter = AmazonAdapter(fetch=fetch)
    offers = adapter.search("running shoes", Filters(), None)  # type: ignore[arg-type]
    assert len(offers) == 4
    assert adapter.last_status == "ok"
    assert urls == ["https://www.amazon.in/s?k=running+shoes"]


def test_sweep_fails_soft_and_records_the_block() -> None:
    adapter = AmazonAdapter(fetch=lambda _u: _Response(503, BLOCK_HTML))
    assert adapter.sweep("running shoes", None) == []  # type: ignore[arg-type]
    assert adapter.blocked is True
    assert adapter.last_status == "blocked"
    assert "api-services-support" in (adapter.last_error or "")


def test_a_large_page_with_no_cards_is_treated_as_a_wall() -> None:
    # Amazon never serves a 200 SERP without result cards, so this is a block
    # dressed up as a page -- reporting it as "ok, zero offers" would be a lie.
    adapter = AmazonAdapter(fetch=lambda _u: _Response(200, "<html>" + "x" * 200_000 + "</html>"))
    assert adapter.search("shoes", Filters(), None) == []  # type: ignore[arg-type]
    assert adapter.last_status == "blocked"


def test_cards_present_but_none_parseable_is_an_honest_empty_result() -> None:
    body = '<div data-asin="BAD" data-component-type="s-search-result"></div>'
    adapter = AmazonAdapter(fetch=lambda _u: _Response(200, body))
    assert adapter.search("shoes", Filters(), None) == []  # type: ignore[arg-type]
    assert adapter.last_status == "ok"
    assert adapter.blocked is False


def test_fetch_page_raises_amazon_blocked() -> None:
    adapter = AmazonAdapter(fetch=lambda _u: _Response(503, BLOCK_HTML))
    with pytest.raises(AmazonBlocked):
        adapter.fetch_page("https://www.amazon.in/s?k=x")


def test_read_response_handles_plain_text_and_bytes() -> None:
    assert amazon.read_response("<html/>") == (200, "<html/>")
    assert amazon.read_response(b"<html/>") == (200, "<html/>")
