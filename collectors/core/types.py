"""Shared value types for every collector adapter.

`Offer` is the contract from the design spec (section 6) and must not drift:
the worker's ingest route and the D1 `products`/`prices` tables are shaped
around it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Mode = Literal["quick", "fashion"]


@dataclass(frozen=True)
class Offer:
    """One priced product observation from one retailer."""

    ext_id: str
    name: str
    price: float
    mrp: float | None
    in_stock: bool
    url: str
    category: str
    brand: str | None = None
    size: str | None = None
    image_url: str | None = None


@dataclass(frozen=True)
class Location:
    """Delivery location a quick-commerce sweep is priced for.

    Quick-commerce prices are dark-store specific, so every sweep carries one
    of these. Blinkit needs `lat`/`lon`; BigBasket needs `pincode` (which it
    resolves to lat/lon itself, see `adapters.bigbasket`). Fashion adapters
    ignore it.
    """

    lat: float | None = None
    lon: float | None = None
    pincode: str | None = None

    @property
    def has_coords(self) -> bool:
        return self.lat is not None and self.lon is not None


@dataclass(frozen=True)
class Category:
    """A retailer-specific category to sweep.

    `id` is opaque and retailer-defined: BigBasket uses the `/cl/<slug>/`
    slug, Blinkit uses `"<l0_cat>/<l1_cat>"`. `slug` is the stable key stored
    against products in D1, so it is deliberately retailer-independent
    ("snacks", "beverages", ...). `label` is for display only.
    """

    id: str
    slug: str
    label: str
    mode: Mode = "quick"


@dataclass(frozen=True)
class Filters:
    """Search-side filters. Pushed to the retailer where it supports them."""

    brands: tuple[str, ...] = ()
    sizes: tuple[str, ...] = ()
    max_price: float | None = None

    def matches(self, offer: Offer) -> bool:
        """Client-side fallback for retailers with no server-side facets."""
        if self.max_price is not None and offer.price > self.max_price:
            return False
        if self.brands:
            brand = (offer.brand or "").casefold()
            if not any(b.casefold() in brand for b in self.brands):
                return False
        if self.sizes:
            size = (offer.size or "").casefold()
            if not any(s.casefold() == size for s in self.sizes):
                return False
        return True
