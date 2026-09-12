"""The adapter contract (spec section 6) and its fail-soft base class."""

from __future__ import annotations

import logging
from typing import Protocol, runtime_checkable

from collectors.core.http import HttpClient
from collectors.core.types import Category, Filters, Location, Mode, Offer

log = logging.getLogger(__name__)


@runtime_checkable
class Adapter(Protocol):
    """Every retailer module exposes exactly this."""

    id: str
    mode: Mode

    def sweep(self, category: Category, loc: Location) -> list[Offer]: ...

    def search(self, q: str, f: Filters, loc: Location) -> list[Offer]: ...


class BaseAdapter:
    """Fail-soft plumbing shared by adapters.

    Spec section 6: *never raise past the boundary*. A broken retailer logs and
    returns `[]`; the sweep keeps the other four retailers' data. Subclasses
    implement `_sweep` / `_search` and are free to raise.
    """

    id: str = "base"
    mode: Mode = "quick"

    #: Generic catalog slug -> this retailer's own category ids.
    #:
    #: The catalog served by ``GET /api/categories`` is deliberately
    #: retailer-independent ("snacks", "staples"), because that slug is the
    #: key products are stored under in D1. Each retailer shards the same
    #: goods differently, so the translation has to live per retailer --
    #: and one generic slug is usually several of the retailer's own
    #: categories, hence a tuple.
    CATEGORY_IDS: dict[str, tuple[str, ...]] = {}

    def __init__(self, client: HttpClient | None = None) -> None:
        self.client = client or HttpClient()
        self.log = logging.getLogger(f"collectors.{self.id}")

    # -- boundary --------------------------------------------------------
    def sweep(self, category: Category, loc: Location) -> list[Offer]:
        try:
            return self._sweep(category, loc)
        except Exception:  # noqa: BLE001 - the boundary is the point
            self.log.exception("sweep failed for %s/%s", self.id, category.slug)
            return []

    def search(self, q: str, f: Filters, loc: Location) -> list[Offer]:
        try:
            return self._search(q, f, loc)
        except Exception:  # noqa: BLE001
            self.log.exception("search failed for %s/%r", self.id, q)
            return []

    # -- category translation --------------------------------------------
    def category_ids(self, category: Category) -> tuple[str, ...]:
        """This retailer's own ids for a generic catalog slug.

        An unmapped slug returns ``()`` and logs. Returning empty is the
        honest answer: sweeping the retailer's *generic* slug instead would
        404 (Blinkit) or quietly return an unrelated listing (BigBasket),
        which is how a missing mapping used to look like a working sweep
        that simply found nothing.
        """
        ids = self.CATEGORY_IDS.get(category.slug)
        if not ids:
            self.log.warning(
                "%s: no category mapping for %r; skipping it for this retailer",
                self.id, category.slug,
            )
            return ()
        return ids

    # -- subclass hooks --------------------------------------------------
    def _sweep(self, category: Category, loc: Location) -> list[Offer]:
        raise NotImplementedError

    def _search(self, q: str, f: Filters, loc: Location) -> list[Offer]:
        raise NotImplementedError


def to_float(value: object) -> float | None:
    """Retailer JSON mixes `"213"`, `213`, `"213.5"`, `""` and `None`."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("\u20b9", "").replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None
