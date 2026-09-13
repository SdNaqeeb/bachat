"""The silent-empty-sweep seam.

A sweep with nothing to collect used to be indistinguishable from a healthy
one: `categories_for_mode()` returned `[]` when `prefs.enabled_categories`
was empty, `sweep_retailer()`'s per-category loop then never ran, every
retailer reported `products_collected=0` with no error, `run()` never called
`worker.ingest()` because `if offers:` was false, and `main()` returned 0
because no retailer had an `error` set.

That is exactly the production failure this file exists to prevent: the
Actions run went green 6x/day for days while `products` stayed empty and the
Deals screen stayed blank. Collecting nothing is not success.
"""

from __future__ import annotations

import pytest

from collectors.run_sweep import ConfigError, categories_for_mode

CATALOG = [
    {"slug": "dairy", "label": "Dairy", "mode": "quick"},
    {"slug": "snacks", "label": "Snacks", "mode": "quick"},
    {"slug": "fashion-tops", "label": "Tops", "mode": "fashion"},
]


def test_no_enabled_categories_for_mode_is_an_error_not_an_empty_sweep() -> None:
    """Zero sweepable categories must fail loudly, not return `[]`."""
    with pytest.raises(ConfigError) as excinfo:
        categories_for_mode(frozenset(), "quick", CATALOG)
    assert "enabled_categories" in str(excinfo.value)


def test_enabled_categories_all_belonging_to_the_other_mode_also_errors() -> None:
    """Fashion-only prefs must not make the quick sweep a silent no-op."""
    with pytest.raises(ConfigError):
        categories_for_mode(frozenset({"fashion-tops"}), "quick", CATALOG)


def test_categories_for_mode_still_returns_the_matching_slugs() -> None:
    selected = categories_for_mode(frozenset({"dairy", "fashion-tops"}), "quick", CATALOG)
    assert [c.slug for c in selected] == ["dairy"]


def test_unknown_slug_is_skipped_but_does_not_break_a_valid_sweep() -> None:
    selected = categories_for_mode(frozenset({"dairy", "no-such-slug"}), "quick", CATALOG)
    assert [c.slug for c in selected] == ["dairy"]


# ---------------------------------------------------------------------------
# The other face of the same masking: categories resolved fine, but every
# adapter returned zero offers (blocked from the Actions datacenter IP, or a
# parser that silently stopped matching). BaseAdapter.sweep() swallows the
# exception and returns `[]`, so nothing is marked blocked or errored and the
# run still exits 0. A sweep that collected nothing at all is a failure.
# ---------------------------------------------------------------------------

from collectors.run_sweep import RetailerRunResult, sweep_outcome_exit_code


def test_all_retailers_collecting_zero_products_exits_nonzero() -> None:
    results = [
        RetailerRunResult(retailer_id="blinkit", products_collected=0),
        RetailerRunResult(retailer_id="bigbasket", products_collected=0),
    ]
    assert sweep_outcome_exit_code(results) == 1


def test_one_retailer_collecting_products_is_a_successful_run() -> None:
    """Spec section 6: one retailer failing must never fail the whole run."""
    results = [
        RetailerRunResult(retailer_id="blinkit", products_collected=38),
        RetailerRunResult(retailer_id="bigbasket", products_collected=0, blocked=True),
    ]
    assert sweep_outcome_exit_code(results) == 0


def test_every_retailer_erroring_still_exits_nonzero() -> None:
    results = [
        RetailerRunResult(retailer_id="blinkit", error="Timeout"),
        RetailerRunResult(retailer_id="bigbasket", error="HTTP 403"),
    ]
    assert sweep_outcome_exit_code(results) == 1


def test_no_results_at_all_exits_nonzero() -> None:
    """No adapter registered for the mode is a misconfiguration, not success."""
    assert sweep_outcome_exit_code([]) == 1
