"""Offline parser tests for the Flipkart adapter (spec section 13).

Fixtures are real captures from 2026-09-12:

* ``flipkart_running_shoes.html`` -- a trimmed ``/search?q=running+shoes`` page
  (40 products reduced to 5, one of them sold out).
* ``flipkart_block_403.html`` -- the verbatim 787-byte "Flipkart reCAPTCHA"
  wall, which is what Flipkart returns for most automated requests.

No test in this file touches the network.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from collectors.adapters import flipkart
from collectors.adapters.flipkart import (
    FlipkartAdapter,
    FlipkartBlocked,
    FlipkartParseError,
    apply_filters,
    build_search_url,
    build_sweep_url,
    detect_block,
    extract_ld_titles,
    extract_state,
    iter_product_values,
    parse_offers,
)
from collectors.core.types import Filters

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SEARCH_HTML = (FIXTURES / "flipkart_running_shoes.html").read_text(encoding="utf-8")
BLOCK_HTML = (FIXTURES / "flipkart_block_403.html").read_text(encoding="utf-8")


# ---------------------------------------------------------------- parsing


def test_extracts_the_redux_blob() -> None:
    state = extract_state(SEARCH_HTML)
    assert "pageDataV4" in state


def test_walks_every_product_summary_widget() -> None:
    # The grid is split across several PRODUCT_SUMMARY widgets, so a parser that
    # only read the first would silently lose three quarters of the page.
    assert len(list(iter_product_values(extract_state(SEARCH_HTML)))) == 5


def test_parses_all_products() -> None:
    assert len(parse_offers(SEARCH_HTML, "running-shoes")) == 5


def test_offer_matches_the_captured_page() -> None:
    by_id = {o.ext_id: o for o in parse_offers(SEARCH_HTML, "running-shoes")}
    offer = by_id["SHOHGHSC6KZ2HQJ9"]
    assert offer.brand == "Aeonik"
    # SPECIAL_PRICE is what you pay; the struck-off FSP is the M.R.P.
    assert offer.price == 452.0
    assert offer.mrp == 1999.0
    assert offer.in_stock is True
    assert offer.size == "8"
    assert offer.category == "running-shoes"
    assert offer.url.startswith("https://www.flipkart.com/aeonik-premium-sports")


def test_negative_buyability_is_out_of_stock() -> None:
    offers = parse_offers(SEARCH_HTML, "running-shoes")
    out = [o for o in offers if not o.in_stock]
    assert len(out) == 1
    assert out[0].ext_id == "SHOGHZGWYFZZYPCE"


def test_image_placeholders_are_resolved_and_https() -> None:
    for offer in parse_offers(SEARCH_HTML, "running-shoes"):
        assert offer.image_url is not None
        assert offer.image_url.startswith("https://")
        assert "{@" not in offer.image_url


def test_price_is_always_below_mrp() -> None:
    for offer in parse_offers(SEARCH_HTML, "running-shoes"):
        assert offer.mrp is None or offer.price < offer.mrp


def test_ld_json_lists_the_same_products() -> None:
    assert len(extract_ld_titles(SEARCH_HTML)) == 5


def test_a_layout_change_is_reported_rather_than_read_as_empty() -> None:
    # ld+json still lists products but the Redux path yields none -> our break,
    # not a block and not an empty catalogue.
    broken = SEARCH_HTML.replace("PRODUCT_SUMMARY", "PRODUCT_SUMMARY_V2")
    with pytest.raises(FlipkartParseError):
        parse_offers(broken, "running-shoes")


def test_missing_redux_blob_raises() -> None:
    with pytest.raises(FlipkartParseError):
        extract_state("<html><body>nothing</body></html>")


def test_product_without_a_price_is_skipped() -> None:
    value = {"id": "X", "titles": {"title": "No price"}, "pricing": {"prices": []}}
    assert flipkart.parse_product(value, "c") is None


def test_price_falls_back_to_the_cheapest_entry_if_flags_change() -> None:
    value = {
        "id": "X",
        "titles": {"title": "T"},
        "pricing": {"prices": [{"value": 900, "strikeOff": True}, {"value": 700, "strikeOff": True}]},
    }
    offer = flipkart.parse_product(value, "c")
    assert offer is not None
    assert offer.price == 700.0
    assert offer.mrp == 900.0


def test_size_read_from_subtitle_when_co_subtitle_is_absent() -> None:
    value = {
        "id": "X",
        "titles": {"title": "T", "subtitle": "White , 9"},
        "pricing": {"prices": [{"value": 100, "strikeOff": False}]},
    }
    offer = flipkart.parse_product(value, "c")
    assert offer is not None
    assert offer.size == "9"


# ------------------------------------------------------- block detection


def test_the_real_787_byte_wall_is_detected() -> None:
    assert len(BLOCK_HTML) < 2_000
    reason = detect_block(403, BLOCK_HTML)
    assert reason is not None
    assert "reCAPTCHA" in reason


def test_a_block_is_never_mistaken_for_zero_results() -> None:
    # Without detect_block this body has no products and would be written to D1
    # as "everything went out of stock", which is the worst possible outcome.
    with pytest.raises(FlipkartParseError):
        parse_offers(BLOCK_HTML, "c")
    assert detect_block(403, BLOCK_HTML) is not None


def test_a_real_search_page_is_not_a_block() -> None:
    assert detect_block(200, SEARCH_HTML) is None


def test_human_challenge_reducer_does_not_flag_a_real_page() -> None:
    # Regression guard: the genuine page ships a "humanChallengeReducer" key in
    # its Redux store, so that substring must not be a block marker.
    assert detect_block(200, '<script>window.__INITIAL_STATE__ = {"humanChallengeReducer":{}};</script>') is None


def test_tiny_body_without_markers_is_still_a_block() -> None:
    reason = detect_block(200, "<html><body>hi</body></html>")
    assert reason is not None
    assert "too small" in reason


def test_large_200_without_a_redux_blob_is_a_block() -> None:
    reason = detect_block(200, "<html>" + "x" * 60_000 + "</html>")
    assert reason == "no window.__INITIAL_STATE__ in a 200 response"


# ---------------------------------------------------------------- urls


def test_search_url() -> None:
    assert build_search_url("running shoes") == "https://www.flipkart.com/search?q=running+shoes"


def test_sweep_url_is_a_sorted_search_not_the_offers_shell() -> None:
    url = build_sweep_url("running shoes")
    assert url.startswith("https://www.flipkart.com/search?q=")
    assert "sort=price_asc" in url


# --------------------------------------------------- client-side filters


def test_brand_filter() -> None:
    offers = parse_offers(SEARCH_HTML, "running-shoes")
    filtered = apply_filters(offers, Filters(brands=("jqr",)))
    assert len(filtered) == 2
    assert {o.brand for o in filtered} == {"JQR"}


def test_size_filter_works_here_unlike_amazon() -> None:
    offers = parse_offers(SEARCH_HTML, "running-shoes")
    filtered = apply_filters(offers, Filters(sizes=("7",)))
    assert filtered
    assert all(o.size == "7" for o in filtered)


def test_max_price_filter() -> None:
    offers = parse_offers(SEARCH_HTML, "running-shoes")
    filtered = apply_filters(offers, Filters(max_price=500))
    assert [o.ext_id for o in filtered] == ["SHOHGHSC6KZ2HQJ9", "SHOHPGCTJJRT3M8F"]


def test_no_filters_is_a_passthrough() -> None:
    offers = parse_offers(SEARCH_HTML, "running-shoes")
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
        return _Response(200, SEARCH_HTML)

    adapter = FlipkartAdapter(fetch=fetch)
    offers = adapter.search("running shoes", Filters(), None)  # type: ignore[arg-type]
    assert len(offers) == 5
    assert adapter.last_status == "ok"
    assert urls == ["https://www.flipkart.com/search?q=running+shoes"]


def test_the_wall_fails_soft_and_is_recorded_as_a_block() -> None:
    adapter = FlipkartAdapter(fetch=lambda _u: _Response(403, BLOCK_HTML))
    assert adapter.search("running shoes", Filters(), None) == []  # type: ignore[arg-type]
    assert adapter.blocked is True
    assert adapter.last_status == "blocked"
    assert "reCAPTCHA" in (adapter.last_error or "")


def test_sweep_fails_soft_too() -> None:
    adapter = FlipkartAdapter(fetch=lambda _u: _Response(403, BLOCK_HTML))
    assert adapter.sweep("running shoes", None) == []  # type: ignore[arg-type]
    assert adapter.blocked is True


def test_a_markup_change_is_reported_as_error_not_block() -> None:
    broken = SEARCH_HTML.replace("PRODUCT_SUMMARY", "PRODUCT_SUMMARY_V2")
    adapter = FlipkartAdapter(fetch=lambda _u: _Response(200, broken))
    assert adapter.search("running shoes", Filters(), None) == []  # type: ignore[arg-type]
    assert adapter.last_status == "error"
    assert adapter.blocked is False


def test_fetch_page_raises_flipkart_blocked() -> None:
    adapter = FlipkartAdapter(fetch=lambda _u: _Response(403, BLOCK_HTML))
    with pytest.raises(FlipkartBlocked):
        adapter.fetch_page("https://www.flipkart.com/search?q=x")


def test_filters_are_applied_to_adapter_results() -> None:
    adapter = FlipkartAdapter(fetch=lambda _u: _Response(200, SEARCH_HTML))
    offers = adapter.search("running shoes", Filters(brands=("campus",)), None)  # type: ignore[arg-type]
    assert [o.brand for o in offers] == ["CAMPUS"]


def test_read_response_handles_plain_text_and_bytes() -> None:
    assert flipkart.read_response("<html/>") == (200, "<html/>")
    assert flipkart.read_response(b"<html/>") == (200, "<html/>")
