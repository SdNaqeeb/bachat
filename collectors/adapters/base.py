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

    def sweep_terms(self, category: Category | str) -> tuple[str, ...]:
        """The retailer's own terms to sweep for ``category``.

        A :class:`Category` is a catalog entry and goes through
        :meth:`category_ids`, so an unmapped slug sweeps nothing rather than
        being handed to the retailer as a literal search term -- that guess is
        what had the fashion adapters searching for the string "fashion-tops".

        A bare ``str`` is a direct call -- a test, or an ad-hoc sweep of one
        known path -- and is used verbatim. The two callers want opposite
        things from an unrecognised value, so the type is what distinguishes
        them.
        """
        if isinstance(category, str):
            return (category,)
        return self.category_ids(category)

    def stored_category(self, category: Category | str) -> str:
        """The value recorded as ``products.category`` for this sweep.

        Always the catalog slug, never the retailer's own term: D1 stores one
        category per product and the app filters on the catalog slug, so a row
        saved as "men-tshirts" would be invisible to a "fashion-tops" filter.
        """
        return category if isinstance(category, str) else category.slug

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
