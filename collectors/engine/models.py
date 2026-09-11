"""Pure data types for the deal engine.

These types are the boundary between I/O (fetching prices, prefs, and prior
alerts from the Worker API) and the pure decision logic in
``collectors.engine.detect``. Nothing in this module touches the network,
a clock, or a database -- ``captured_at`` and any "now" values are passed in
by the caller.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time

# The period-low trigger and the "lowest in N days" honesty label are both
# bounded by this window. Even if a product has 90 days of history, the
# engine only ever verifies (and claims) up to this many days, because that
# is what the period-low query actually inspects (spec 7).
MAX_HISTORY_WINDOW_DAYS = 30

DEFAULT_THRESHOLD = 0.60
DEFAULT_QUIET_START = time(23, 0)
DEFAULT_QUIET_END = time(8, 0)


@dataclass(frozen=True)
class QuietHours:
    """A daily quiet window in local (IST) time. May wrap midnight."""

    start: time = DEFAULT_QUIET_START
    end: time = DEFAULT_QUIET_END


@dataclass(frozen=True)
class UserPrefs:
    """The subset of ``prefs`` the engine needs, already parsed."""

    mode: str  # 'quick' | 'fashion' -- the user's CURRENT mode
    enabled_categories: frozenset[str]
    threshold: float = DEFAULT_THRESHOLD
    quiet_hours: QuietHours = field(default_factory=QuietHours)


@dataclass(frozen=True)
class ProductSnapshot:
    """One freshly-collected observation for a product, plus just enough
    trailing history for the engine to decide honestly.

    ``trailing_daily_mins`` holds the daily minimum price for each PRIOR day
    of history the caller found in ``price_daily`` (today's own row is not
    included -- it is what ``price`` represents). The caller is responsible
    for windowing this to at most ``MAX_HISTORY_WINDOW_DAYS`` entries; the
    engine trusts ``len(trailing_daily_mins)`` as the true count of prior
    days observed and will never claim more history than that implies.
    """

    product_id: str
    retailer_id: str
    category: str
    mode: str  # 'quick' | 'fashion' -- the retailer/product's mode
    name: str
    price: float
    mrp: float | None
    in_stock: bool
    captured_at: datetime  # timezone-aware
    trailing_daily_mins: tuple[float, ...] = ()


AlertKind = str  # 'threshold' | 'period_low'


@dataclass(frozen=True)
class Alert:
    product_id: str
    retailer_id: str
    kind: AlertKind
    price: float
    mrp: float | None
    lowest_in_days: int
    message: str
    category: str
    captured_at: datetime  # when the observation happened (UTC)
    scheduled_for: datetime  # when it should be delivered (UTC)

    @property
    def held(self) -> bool:
        return self.scheduled_for > self.captured_at

    @property
    def dedupe_key(self) -> tuple[str, str, float]:
        return (self.product_id, self.kind, self.price)
