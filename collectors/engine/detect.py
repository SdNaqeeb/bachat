"""Deal detection: pure functions over data, no I/O.

Two independent triggers (spec section 7):

1. Threshold  -- ``(mrp - price) / mrp >= user_threshold``.
2. Period low -- ``price <= min(price_daily over the trailing 30 days)``.

THE HONESTY RULE: the system only knows the history it has actually
collected. Until 30 days of observations exist for a product, every alert
must say "lowest in N days" with the real N -- never claim a 30-day low that
hasn't been substantiated. See ``lowest_in_days`` below; it is the single
function this whole module exists to get right.

Dedupe (same product+kind+price never notifies twice) and quiet-hours
holding are applied on top of the raw triggers. All of it is pure: the
entrypoint (``collectors/run_sweep.py``) does the I/O and calls these
functions with plain data.
"""

from __future__ import annotations

from collectors.engine import quiet_hours
from collectors.engine.models import (
    MAX_HISTORY_WINDOW_DAYS,
    Alert,
    ProductSnapshot,
    UserPrefs,
)


def lowest_in_days(trailing_daily_mins: tuple[float, ...]) -> int:
    """The number of days we can honestly claim a price is the lowest
    over, given ``len(trailing_daily_mins)`` prior days of collected
    history plus today's own observation.

    - 0 prior days (brand new product) -> 1 (today is the only data point).
    - 29 prior days -> 30 (a full 30-day window, including today).
    - 30+ prior days -> capped at MAX_HISTORY_WINDOW_DAYS, because the
      period-low trigger only ever inspects a 30-day trailing window --
      claiming more would be a claim the engine never checked.
    """
    return min(len(trailing_daily_mins) + 1, MAX_HISTORY_WINDOW_DAYS)


def is_threshold_hit(price: float, mrp: float | None, threshold: float) -> bool:
    if mrp is None or mrp <= 0:
        return False
    pct_off = (mrp - price) / mrp
    return pct_off >= threshold


def is_period_low(price: float, trailing_daily_mins: tuple[float, ...]) -> bool:
    if not trailing_daily_mins:
        # No prior history at all: today's single observation is trivially
        # the lowest ever seen. It is still honestly labelled "lowest in 1
        # day" by lowest_in_days(), never a 30-day low.
        return True
    return price <= min(trailing_daily_mins)


def _fmt_price(price: float) -> str:
    if price == int(price):
        return f"₹{int(price)}"
    return f"₹{price:.2f}"


def _threshold_message(price: float, mrp: float) -> str:
    pct_off = round((mrp - price) / mrp * 100)
    return f"{pct_off}% off MRP — {_fmt_price(price)} (MRP {_fmt_price(mrp)})"


def _period_low_message(price: float, days: int) -> str:
    if days >= MAX_HISTORY_WINDOW_DAYS:
        return f"30-day low — {_fmt_price(price)}"
    unit = "day" if days == 1 else "days"
    return f"Lowest in {days} {unit} — {_fmt_price(price)}"


def raw_triggers(snapshot: ProductSnapshot, threshold: float) -> list[Alert]:
    """Evaluate both triggers for one observation, with no filtering,
    scheduling, or dedupe applied. Delivery time is set to ``captured_at``
    (i.e. "not held") -- callers apply ``apply_quiet_hours`` afterwards.
    """
    alerts: list[Alert] = []

    if snapshot.mrp is not None and is_threshold_hit(
        snapshot.price, snapshot.mrp, threshold
    ):
        alerts.append(
            Alert(
                product_id=snapshot.product_id,
                retailer_id=snapshot.retailer_id,
                kind="threshold",
                price=snapshot.price,
                mrp=snapshot.mrp,
                lowest_in_days=lowest_in_days(snapshot.trailing_daily_mins),
                message=_threshold_message(snapshot.price, snapshot.mrp),
                category=snapshot.category,
                captured_at=snapshot.captured_at,
                scheduled_for=snapshot.captured_at,
            )
        )

    if is_period_low(snapshot.price, snapshot.trailing_daily_mins):
        days = lowest_in_days(snapshot.trailing_daily_mins)
        alerts.append(
            Alert(
                product_id=snapshot.product_id,
                retailer_id=snapshot.retailer_id,
                kind="period_low",
                price=snapshot.price,
                mrp=snapshot.mrp,
                lowest_in_days=days,
                message=_period_low_message(snapshot.price, days),
                category=snapshot.category,
                captured_at=snapshot.captured_at,
                scheduled_for=snapshot.captured_at,
            )
        )

    return alerts


def passes_filters(snapshot: ProductSnapshot, prefs: UserPrefs) -> bool:
    """Only the user's enabled categories and current mode produce alerts.
    An out-of-stock offer never alerts either -- there is nothing to buy.
    """
    if snapshot.mode != prefs.mode:
        return False
    if snapshot.category not in prefs.enabled_categories:
        return False
    if not snapshot.in_stock:
        return False
    return True


def apply_quiet_hours(alerts: list[Alert], prefs: UserPrefs) -> list[Alert]:
    """Reschedule alerts that land inside quiet hours to the next release
    time. Alerts are HELD, never dropped.
    """
    rescheduled = []
    for alert in alerts:
        scheduled_for = quiet_hours.schedule(alert.captured_at, prefs.quiet_hours)
        rescheduled.append(
            alert if scheduled_for == alert.scheduled_for else _with_schedule(alert, scheduled_for)
        )
    return rescheduled


def _with_schedule(alert: Alert, scheduled_for) -> Alert:  # type: ignore[no-untyped-def]
    from dataclasses import replace

    return replace(alert, scheduled_for=scheduled_for)


def dedupe(alerts: list[Alert], already_sent: set[tuple[str, str, float]]) -> list[Alert]:
    """The same product at the same price (for the same trigger kind)
    never notifies twice. ``already_sent`` is the set of
    (product_id, kind, price) tuples read from the ``alerts`` table.
    """
    return [a for a in alerts if a.dedupe_key not in already_sent]


def evaluate_observation(
    snapshot: ProductSnapshot,
    prefs: UserPrefs,
    already_sent: set[tuple[str, str, float]],
) -> list[Alert]:
    """The full pipeline for one product observation: filter -> trigger ->
    quiet-hours scheduling -> dedupe. Pure; no I/O.
    """
    if not passes_filters(snapshot, prefs):
        return []

    triggered = raw_triggers(snapshot, prefs.threshold)
    scheduled = apply_quiet_hours(triggered, prefs)
    return dedupe(scheduled, already_sent)


def evaluate_batch(
    snapshots: list[ProductSnapshot],
    prefs: UserPrefs,
    already_sent: set[tuple[str, str, float]],
) -> list[Alert]:
    """Evaluate many observations, deduping across the whole batch too
    (so two offers for the same product/price within one sweep -- which
    should not happen, but adapters can be buggy -- still only alert once).
    """
    out: list[Alert] = []
    seen = set(already_sent)
    for snapshot in snapshots:
        for alert in evaluate_observation(snapshot, prefs, seen):
            out.append(alert)
            seen.add(alert.dedupe_key)
    return out
