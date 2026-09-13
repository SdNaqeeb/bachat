"""At most a handful of notifications per sweep.

One real sweep produced 5,453 alerts in a single run. Delivering those would
not be a deal feed, it would be a denial of service against the user's phone --
and a notification stream nobody can read is worth less than none at all.

The cap is on *delivery only*. Everything still reaches D1: products are
written by `worker.ingest()` regardless of alerts, so the Deals screen shows
the full ranked feed either way, and alerts that lose the cut stay in the held
queue rather than being dropped. The next sweep reconsiders them against the
same ranking, so nothing is lost -- delivery is spread out rather than
discarded.

Ranking is by discount depth, because if only a few notifications get through
they should be the best ones available, not whichever the engine happened to
evaluate first.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from collectors.engine.models import Alert
from collectors.run_sweep import MAX_ALERTS_PER_SWEEP, select_alerts_to_send

NOW = datetime(2026, 9, 14, 3, 0, tzinfo=timezone.utc)


def alert(product: str, price: float, mrp: float | None, *, low_days: int = 0) -> Alert:
    return Alert(
        product_id=product,
        retailer_id="blinkit",
        kind="threshold",
        price=price,
        mrp=mrp,
        lowest_in_days=low_days,
        message=f"{product} at {price}",
        category="snacks",
        captured_at=NOW,
        scheduled_for=NOW - timedelta(minutes=1),
    )


def test_a_small_batch_is_sent_whole() -> None:
    ready = [alert(f"p{i}", 50.0, 100.0) for i in range(3)]

    to_send, deferred = select_alerts_to_send(ready, 10)

    assert len(to_send) == 3
    assert deferred == []


def test_an_oversized_batch_is_capped() -> None:
    ready = [alert(f"p{i}", 50.0, 100.0) for i in range(25)]

    to_send, deferred = select_alerts_to_send(ready, 10)

    assert len(to_send) == 10
    assert len(deferred) == 15


def test_nothing_is_dropped_between_the_two_halves() -> None:
    """The cap defers; it must never discard."""
    ready = [alert(f"p{i}", 50.0, 100.0) for i in range(25)]

    to_send, deferred = select_alerts_to_send(ready, 10)

    ids = sorted(a.product_id for a in to_send + deferred)
    assert ids == sorted(a.product_id for a in ready)


def test_the_deepest_discounts_are_the_ones_delivered() -> None:
    """If only a few get through, they should be the best few."""
    shallow = alert("shallow", 90.0, 100.0)   # 10% off
    middling = alert("middling", 50.0, 100.0)  # 50% off
    deep = alert("deep", 10.0, 100.0)          # 90% off

    to_send, deferred = select_alerts_to_send([shallow, middling, deep], 2)

    assert [a.product_id for a in to_send] == ["deep", "middling"]
    assert [a.product_id for a in deferred] == ["shallow"]


def test_an_alert_with_no_mrp_ranks_below_a_real_discount() -> None:
    """No MRP means no computable depth. It is ranked last rather than guessed."""
    no_mrp = alert("unknown", 50.0, None)
    real = alert("real", 80.0, 100.0)  # only 20% off, but it is known

    to_send, _deferred = select_alerts_to_send([no_mrp, real], 1)

    assert [a.product_id for a in to_send] == ["real"]


def test_ties_break_on_the_longer_recorded_low() -> None:
    a = alert("short", 50.0, 100.0, low_days=3)
    b = alert("long", 50.0, 100.0, low_days=30)

    to_send, _deferred = select_alerts_to_send([a, b], 1)

    assert [x.product_id for x in to_send] == ["long"]


def test_a_zero_limit_defers_everything_rather_than_sending_all() -> None:
    """A misread limit must fail quiet, not loud-into-the-user's-phone."""
    ready = [alert(f"p{i}", 50.0, 100.0) for i in range(4)]

    to_send, deferred = select_alerts_to_send(ready, 0)

    assert to_send == []
    assert len(deferred) == 4


def test_an_empty_batch_is_fine() -> None:
    assert select_alerts_to_send([], MAX_ALERTS_PER_SWEEP) == ([], [])


def test_the_shipped_cap_is_small_enough_to_read() -> None:
    """A number nobody would call 'a few' defeats the point of the cap."""
    assert 1 <= MAX_ALERTS_PER_SWEEP <= 20
