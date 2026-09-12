"""The registry/entrypoint seam.

Every other adapter test constructs its adapter directly
(``BlinkitAdapter()``), so none of them exercise what ``run_sweep.run()``
actually iterates: the values of ``ADAPTERS``. That gap let a registry of
*classes* reach production against a caller expecting *instances*, where
``adapter.sweep(category, loc)`` silently became an unbound call and every
retailer failed with ``missing 1 required positional argument: 'loc'``.
"""

from __future__ import annotations

import inspect

import pytest

from collectors.adapters import ADAPTERS
from collectors.core.types import Category, Location
from collectors.run_sweep import build_adapter

CATEGORY = Category(id="x", slug="dairy", label="Dairy", mode="quick")
LOCATION = Location(lat=12.97, lon=77.59, pincode="560034")


@pytest.mark.parametrize("retailer_id", sorted(ADAPTERS))
def test_registered_adapter_sweep_accepts_category_and_location(retailer_id: str) -> None:
    """What run() does to each registry entry must type-check."""
    adapter = build_adapter(ADAPTERS[retailer_id])
    # .bind() raises TypeError on exactly the unbound-call bug.
    inspect.signature(adapter.sweep).bind(CATEGORY, LOCATION)


@pytest.mark.parametrize("retailer_id", sorted(ADAPTERS))
def test_registered_adapter_exposes_id_and_mode(retailer_id: str) -> None:
    adapter = build_adapter(ADAPTERS[retailer_id])
    assert adapter.id == retailer_id
    assert adapter.mode in {"quick", "fashion"}


def test_build_adapter_is_idempotent_for_instances() -> None:
    """A registry may hold either; an instance must pass through untouched."""
    first = build_adapter(ADAPTERS["blinkit"])
    assert build_adapter(first) is first
