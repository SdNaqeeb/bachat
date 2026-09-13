"""The fashion sweep collects men's items only.

The catalog's fashion slugs are gender-neutral words, and the fashion adapters
used to hand those slugs straight to the retailer as a search term:
`category_label()` returns `Category.slug` first, so Amazon and Flipkart were
literally searching for the string "fashion-tops" and Myntra was requesting
`myntra.com/fashion-tops`, which is not a listing path. Whatever came back was
whatever the site decided that string meant -- women's apparel included.

The grocery adapters already solved this shape: `BaseAdapter.CATEGORY_IDS` maps
one catalog slug to the retailer's own ids, and `_sweep` loops over them. The
fashion adapters simply never adopted it. These tests pin that they now do, and
that every id they map is a men's one.

Every term asserted here was verified live on 2026-09-13 and returned a full
page of men's products (Myntra 50/path, Amazon 47-48/query).

No test in this file touches the network.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from collectors.adapters.amazon import AmazonAdapter
from collectors.adapters.flipkart import FlipkartAdapter
from collectors.adapters.myntra import MyntraAdapter
from collectors.core.types import Category, Location

FIXTURES = Path(__file__).resolve().parent / "fixtures"

#: Every fashion slug in the `categories` catalog (worker/schema.sql).
FASHION_SLUGS = (
    "fashion-tops",
    "fashion-bottoms",
    "fashion-footwear",
    "fashion-accessories",
)

ADAPTERS = (
    (MyntraAdapter, "myntra_men_tshirts.html"),
    (AmazonAdapter, "amazon_running_shoes.html"),
    (FlipkartAdapter, "flipkart_running_shoes.html"),
)

LOC = Location(lat=17.4435, lon=78.4645, pincode="500016")


def category(slug: str) -> Category:
    return Category(id=slug, slug=slug, label=slug, mode="fashion")


# --------------------------------------------------------------- mappings


@pytest.mark.parametrize("adapter_cls,_fixture", ADAPTERS)
def test_every_fashion_slug_is_mapped(adapter_cls: type, _fixture: str) -> None:
    """An unmapped slug sweeps nothing, so every catalog slug needs an entry."""
    missing = [s for s in FASHION_SLUGS if not adapter_cls.CATEGORY_IDS.get(s)]
    assert not missing, f"{adapter_cls.__name__} maps none of {missing}"


@pytest.mark.parametrize("adapter_cls,_fixture", ADAPTERS)
def test_every_mapped_term_is_mens(adapter_cls: type, _fixture: str) -> None:
    """No women's term may appear -- that is the whole point of the change.

    Note the substring trap: "women" contains "men", so a naive `"men" in term`
    check passes for "women-tshirts". Both halves are asserted.
    """
    for slug, ids in adapter_cls.CATEGORY_IDS.items():
        if not slug.startswith("fashion-"):
            continue
        for term in ids:
            lowered = term.lower()
            assert "women" not in lowered, f"{adapter_cls.__name__}/{slug}: {term!r} is women's"
            assert "men" in lowered, f"{adapter_cls.__name__}/{slug}: {term!r} is not men-specific"


# ------------------------------------------------------------ sweep behaviour


def recording_adapter(adapter_cls: type, fixture: str):
    """An adapter whose fetches are recorded and served from a fixture."""
    body = (FIXTURES / fixture).read_text(encoding="utf-8")
    seen: list[str] = []

    def fetch(url: str) -> str:
        seen.append(url)
        return body

    return adapter_cls(fetch=fetch), seen


@pytest.mark.parametrize("adapter_cls,fixture", ADAPTERS)
def test_sweep_requests_one_url_per_mapped_term(adapter_cls: type, fixture: str) -> None:
    """One catalog slug fans out to every retailer term mapped for it."""
    adapter, seen = recording_adapter(adapter_cls, fixture)
    expected = adapter_cls.CATEGORY_IDS["fashion-tops"]

    adapter._sweep(category("fashion-tops"), LOC)

    assert len(seen) == len(expected), f"{adapter_cls.__name__}: {seen}"
    for term in expected:
        token = term.replace("'", "").replace(" ", "").replace("-", "").lower()
        joined = "".join(seen).replace("'", "").replace("%20", "").replace("+", "")
        joined = joined.replace(" ", "").replace("-", "").replace("%27", "").lower()
        assert token in joined, f"{adapter_cls.__name__}: {term!r} not requested in {seen}"


@pytest.mark.parametrize("adapter_cls,fixture", ADAPTERS)
def test_sweep_deduplicates_across_terms(adapter_cls: type, fixture: str) -> None:
    """Two terms returning the same product yield it once, not twice.

    Men's t-shirts and men's casual shirts genuinely overlap on these sites, so
    this is the real case, not a contrived one.
    """
    adapter, _seen = recording_adapter(adapter_cls, fixture)

    offers = adapter._sweep(category("fashion-tops"), LOC)

    ext_ids = [o.ext_id for o in offers]
    assert ext_ids, f"{adapter_cls.__name__} collected nothing from its fixture"
    assert len(ext_ids) == len(set(ext_ids)), f"{adapter_cls.__name__} emitted duplicates"


@pytest.mark.parametrize("adapter_cls,fixture", ADAPTERS)
def test_offers_are_stored_against_the_catalog_slug(adapter_cls: type, fixture: str) -> None:
    """`products.category` must stay the generic slug, not the retailer's term.

    D1 stores one category per product and the app's picker filters on the
    catalog slug, so storing "men-tshirts" would make the row invisible to a
    "fashion-tops" filter.
    """
    adapter, _seen = recording_adapter(adapter_cls, fixture)

    offers = adapter._sweep(category("fashion-tops"), LOC)

    assert offers
    assert {o.category for o in offers} == {"fashion-tops"}


@pytest.mark.parametrize("adapter_cls,fixture", ADAPTERS)
def test_unmapped_slug_fetches_nothing(adapter_cls: type, fixture: str) -> None:
    """An unknown slug is skipped loudly rather than swept as a search term."""
    adapter, seen = recording_adapter(adapter_cls, fixture)

    offers = adapter._sweep(category("fashion-nonexistent"), LOC)

    assert seen == []
    assert offers == []


@pytest.mark.parametrize("adapter_cls,fixture", ADAPTERS)
def test_one_failing_term_does_not_cost_the_others(adapter_cls: type, fixture: str) -> None:
    """Mirrors the grocery rule: a dead term keeps what the others found."""
    body = (FIXTURES / fixture).read_text(encoding="utf-8")
    calls: list[str] = []

    def fetch(url: str) -> str:
        calls.append(url)
        if len(calls) == 1:
            raise RuntimeError("first term exploded")
        return body

    adapter = adapter_cls(fetch=fetch)
    terms = adapter_cls.CATEGORY_IDS["fashion-tops"]
    if len(terms) < 2:
        pytest.skip(f"{adapter_cls.__name__} maps a single term for fashion-tops")

    offers = adapter._sweep(category("fashion-tops"), LOC)

    assert offers, "a failing first term wiped out the surviving ones"
