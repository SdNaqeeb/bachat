"""Table-driven tests for collectors/engine.

Coverage map (spec section 7, and section 13's requirement that the engine
be table-driven for threshold / period-low / the "N days" honesty rule):

  - honesty rule: lowest_in_days() for 0, 1, 12, 29, 30, 90 prior days
  - threshold trigger: boundary at exactly the configured threshold
  - period-low trigger: brand-new product, tie, strictly-lower, strictly-higher
  - dedupe: same (product, kind, price) never fires twice; different price does
  - quiet hours: boundary conditions and the midnight wrap
  - filtering: category / mode / stock
"""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone

import pytest

from collectors.engine import quiet_hours
from collectors.engine.detect import (
    apply_quiet_hours,
    dedupe,
    evaluate_batch,
    evaluate_observation,
    is_period_low,
    is_threshold_hit,
    lowest_in_days,
    passes_filters,
    raw_triggers,
)
from collectors.engine.models import (
    MAX_HISTORY_WINDOW_DAYS,
    ProductSnapshot,
    QuietHours,
    UserPrefs,
)

UTC = timezone.utc
IST = quiet_hours.IST


def snap(
    *,
    product_id: str = "p1",
    retailer_id: str = "blinkit",
    category: str = "dairy",
    mode: str = "quick",
    price: float = 100.0,
    mrp: float | None = 200.0,
    in_stock: bool = True,
    captured_at: datetime | None = None,
    trailing_daily_mins: tuple[float, ...] = (),
) -> ProductSnapshot:
    return ProductSnapshot(
        product_id=product_id,
        retailer_id=retailer_id,
        category=category,
        mode=mode,
        name="Test product",
        price=price,
        mrp=mrp,
        in_stock=in_stock,
        captured_at=captured_at or datetime(2026, 9, 12, 12, 0, tzinfo=UTC),
        trailing_daily_mins=trailing_daily_mins,
    )


def prefs(
    *,
    mode: str = "quick",
    enabled_categories: frozenset[str] = frozenset({"dairy", "staples"}),
    threshold: float = 0.60,
    quiet: QuietHours | None = None,
) -> UserPrefs:
    return UserPrefs(
        mode=mode,
        enabled_categories=enabled_categories,
        threshold=threshold,
        quiet_hours=quiet or QuietHours(),
    )


# ---------------------------------------------------------------------------
# THE HONESTY RULE -- lowest_in_days()
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "prior_days,expected_label_days",
    [
        (0, 1),  # brand new product: only today's observation exists
        (1, 2),
        (12, 13),
        (29, 30),  # full window reached, including today
        (30, MAX_HISTORY_WINDOW_DAYS),  # more than the window -> capped
        (90, MAX_HISTORY_WINDOW_DAYS),  # lots of history -> still capped
    ],
)
def test_lowest_in_days_honesty_rule(prior_days: int, expected_label_days: int) -> None:
    trailing = tuple(float(100 + i) for i in range(prior_days))
    assert lowest_in_days(trailing) == expected_label_days


@pytest.mark.parametrize("prior_days", [0, 1, 12, 28])
def test_period_low_message_never_claims_30_days_before_it_is_true(prior_days: int) -> None:
    """The single most important assertion in this file: under 30 days of
    substantiated history, the message must NEVER say "30-day low" -- it
    must say the real number.
    """
    trailing = tuple(float(100 + i) for i in range(prior_days))
    s = snap(price=50.0, trailing_daily_mins=trailing)
    alerts = raw_triggers(s, threshold=0.99)  # threshold impossible to hit
    period_low = next(a for a in alerts if a.kind == "period_low")
    assert "30-day low" not in period_low.message
    assert f"{prior_days + 1}" in period_low.message
    assert period_low.lowest_in_days == prior_days + 1


@pytest.mark.parametrize("prior_days", [29, 30, 45, 90, 365])
def test_period_low_message_says_30_day_low_once_substantiated(prior_days: int) -> None:
    trailing = tuple(float(100 + i) for i in range(prior_days))
    s = snap(price=50.0, trailing_daily_mins=trailing)
    alerts = raw_triggers(s, threshold=0.99)
    period_low = next(a for a in alerts if a.kind == "period_low")
    assert "30-day low" in period_low.message
    assert period_low.lowest_in_days == MAX_HISTORY_WINDOW_DAYS


def test_singular_day_wording() -> None:
    s = snap(price=50.0, trailing_daily_mins=())
    alerts = raw_triggers(s, threshold=0.99)
    period_low = next(a for a in alerts if a.kind == "period_low")
    assert "Lowest in 1 day —" in period_low.message
    assert "1 days" not in period_low.message


# ---------------------------------------------------------------------------
# Threshold trigger
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "price,mrp,threshold,expected",
    [
        (40.0, 100.0, 0.60, True),  # exactly 60% off -> boundary hits
        (40.01, 100.0, 0.60, False),  # a paisa short of 60% off
        (100.0, 100.0, 0.60, False),  # no discount at all
        (0.0, 100.0, 0.60, True),  # free -> 100% off, well past threshold
        (50.0, 0.0, 0.60, False),  # degenerate mrp: never trigger, never divide by zero
        (50.0, None, 0.60, False),  # no mrp at all
    ],
)
def test_threshold_boundary(price: float, mrp: float | None, threshold: float, expected: bool) -> None:
    assert is_threshold_hit(price, mrp, threshold) is expected


def test_threshold_is_user_configurable() -> None:
    s = snap(price=70.0, mrp=100.0)  # 30% off
    assert raw_triggers(s, threshold=0.60) == [
        a for a in raw_triggers(s, threshold=0.60) if a.kind != "threshold"
    ]
    hit = [a for a in raw_triggers(s, threshold=0.25) if a.kind == "threshold"]
    assert len(hit) == 1


# ---------------------------------------------------------------------------
# Period-low trigger
# ---------------------------------------------------------------------------


def test_period_low_true_for_brand_new_product() -> None:
    assert is_period_low(price=99.0, trailing_daily_mins=()) is True


def test_period_low_true_on_tie() -> None:
    assert is_period_low(price=50.0, trailing_daily_mins=(50.0, 60.0, 55.0)) is True


def test_period_low_true_when_strictly_below_trailing_min() -> None:
    assert is_period_low(price=40.0, trailing_daily_mins=(50.0, 60.0)) is True


def test_period_low_false_when_above_trailing_min() -> None:
    assert is_period_low(price=51.0, trailing_daily_mins=(50.0, 60.0)) is False


def test_both_triggers_can_fire_together() -> None:
    # 70% off AND a period low.
    s = snap(price=30.0, mrp=100.0, trailing_daily_mins=(40.0, 50.0))
    alerts = raw_triggers(s, threshold=0.60)
    kinds = {a.kind for a in alerts}
    assert kinds == {"threshold", "period_low"}


# ---------------------------------------------------------------------------
# Dedupe
# ---------------------------------------------------------------------------


def test_dedupe_same_product_same_price_same_kind_is_dropped() -> None:
    s = snap(price=30.0, mrp=100.0)
    alerts = raw_triggers(s, threshold=0.60)
    already = {(a.product_id, a.kind, a.price) for a in alerts}
    assert dedupe(alerts, already) == []


def test_dedupe_different_price_still_notifies() -> None:
    s = snap(price=30.0, mrp=100.0)
    alerts = raw_triggers(s, threshold=0.60)
    already = {(alerts[0].product_id, alerts[0].kind, 999.0)}
    assert dedupe(alerts, already) == alerts


def test_dedupe_different_kind_same_price_still_notifies() -> None:
    s = snap(price=30.0, mrp=100.0, trailing_daily_mins=(40.0,))
    alerts = raw_triggers(s, threshold=0.60)
    threshold_alert = next(a for a in alerts if a.kind == "threshold")
    already = {(threshold_alert.product_id, "period_low", threshold_alert.price)}
    # the threshold alert (a different kind) must survive
    survivors = dedupe(alerts, already)
    assert any(a.kind == "threshold" for a in survivors)


def test_evaluate_batch_dedupes_within_the_same_run() -> None:
    """Two offers for the same product/price in one sweep (adapter bug, or
    a genuine re-scrape) must still only alert once.
    """
    s1 = snap(product_id="p1", price=30.0, mrp=100.0)
    s2 = snap(product_id="p1", price=30.0, mrp=100.0)
    alerts = evaluate_batch([s1, s2], prefs(threshold=0.60), already_sent=set())
    threshold_alerts = [a for a in alerts if a.kind == "threshold"]
    assert len(threshold_alerts) == 1


# ---------------------------------------------------------------------------
# Quiet hours: boundaries and the midnight wrap
# ---------------------------------------------------------------------------


def ist_dt(hour: int, minute: int = 0, day: int = 12) -> datetime:
    return datetime(2026, 9, day, hour, minute, tzinfo=IST)


DEFAULT_QUIET = QuietHours(start=time(23, 0), end=time(8, 0))


@pytest.mark.parametrize(
    "hour,minute,expected_quiet",
    [
        (22, 59, False),
        (23, 0, True),  # start boundary is inclusive
        (23, 30, True),
        (0, 0, True),  # midnight, inside the wrap
        (3, 0, True),
        (7, 59, True),
        (8, 0, False),  # end boundary is exclusive -- flows immediately
        (8, 1, False),
        (12, 0, False),
    ],
)
def test_quiet_hours_boundaries_and_midnight_wrap(hour: int, minute: int, expected_quiet: bool) -> None:
    ts = ist_dt(hour, minute)
    assert quiet_hours.is_quiet(ts, DEFAULT_QUIET) is expected_quiet


def test_quiet_hours_release_time_from_late_evening_is_next_morning() -> None:
    ts = ist_dt(23, 30, day=12)
    released = quiet_hours.release_time(ts, DEFAULT_QUIET).astimezone(IST)
    assert (released.day, released.hour, released.minute) == (13, 8, 0)


def test_quiet_hours_release_time_from_early_morning_is_same_morning() -> None:
    ts = ist_dt(3, 0, day=12)
    released = quiet_hours.release_time(ts, DEFAULT_QUIET).astimezone(IST)
    assert (released.day, released.hour, released.minute) == (12, 8, 0)


def test_quiet_hours_release_time_exactly_at_midnight() -> None:
    ts = ist_dt(0, 0, day=12)
    released = quiet_hours.release_time(ts, DEFAULT_QUIET).astimezone(IST)
    assert (released.day, released.hour, released.minute) == (12, 8, 0)


def test_non_wrapping_quiet_window() -> None:
    # A hypothetical non-wrapping window, e.g. an afternoon nap block.
    q = QuietHours(start=time(13, 0), end=time(15, 0))
    assert quiet_hours.is_quiet(ist_dt(12, 59), q) is False
    assert quiet_hours.is_quiet(ist_dt(13, 0), q) is True
    assert quiet_hours.is_quiet(ist_dt(14, 59), q) is True
    assert quiet_hours.is_quiet(ist_dt(15, 0), q) is False


def test_degenerate_equal_start_end_is_never_quiet() -> None:
    q = QuietHours(start=time(9, 0), end=time(9, 0))
    for hour in (0, 9, 12, 23):
        assert quiet_hours.is_quiet(ist_dt(hour), q) is False


def test_naive_datetime_rejected() -> None:
    with pytest.raises(ValueError):
        quiet_hours.is_quiet(datetime(2026, 9, 12, 23, 0), DEFAULT_QUIET)


def test_alerts_in_quiet_hours_are_held_not_dropped() -> None:
    captured = datetime(2026, 9, 12, 18, 5, tzinfo=IST)  # 23:35 IST wraps
    # Build a captured_at that is 23:35 IST -> convert explicitly.
    captured = ist_dt(23, 35).astimezone(UTC)
    s = snap(price=30.0, mrp=100.0, captured_at=captured)
    alerts = raw_triggers(s, threshold=0.60)
    held = apply_quiet_hours(alerts, prefs(threshold=0.60))
    assert len(held) == len(alerts)
    for a in held:
        assert a.held is True
        assert a.scheduled_for > a.captured_at


def test_alerts_outside_quiet_hours_deliver_immediately() -> None:
    captured = ist_dt(12, 0).astimezone(UTC)
    s = snap(price=30.0, mrp=100.0, captured_at=captured)
    alerts = raw_triggers(s, threshold=0.60)
    scheduled = apply_quiet_hours(alerts, prefs(threshold=0.60))
    for a in scheduled:
        assert a.held is False
        assert a.scheduled_for == a.captured_at


# ---------------------------------------------------------------------------
# Filtering: category, mode, stock
# ---------------------------------------------------------------------------


def test_disabled_category_never_alerts() -> None:
    s = snap(category="fashion-tops", price=1.0, mrp=100.0)
    assert passes_filters(s, prefs(enabled_categories=frozenset({"dairy"}))) is False


def test_wrong_mode_never_alerts() -> None:
    s = snap(mode="fashion", category="dairy", price=1.0, mrp=100.0)
    assert passes_filters(s, prefs(mode="quick")) is False


def test_out_of_stock_never_alerts() -> None:
    s = snap(in_stock=False, price=1.0, mrp=100.0)
    assert passes_filters(s, prefs()) is False


def test_full_pipeline_end_to_end() -> None:
    captured = ist_dt(12, 0).astimezone(UTC)
    s = snap(price=30.0, mrp=100.0, category="dairy", mode="quick", captured_at=captured)
    result = evaluate_observation(s, prefs(threshold=0.60), already_sent=set())
    assert {a.kind for a in result} == {"threshold", "period_low"}
    # Re-running with the same price and an already_sent set from the
    # first pass must produce nothing new.
    already = {a.dedupe_key for a in result}
    assert evaluate_observation(s, prefs(threshold=0.60), already_sent=already) == []
