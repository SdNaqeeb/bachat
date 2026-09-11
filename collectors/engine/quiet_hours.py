"""Quiet-hours arithmetic, in IST, handling the midnight wrap.

Pure functions only: every timestamp comes in and goes out as a
timezone-aware ``datetime``. No clock reads happen here.
"""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone

from collectors.engine.models import QuietHours

IST = timezone(timedelta(hours=5, minutes=30), name="IST")


def to_ist(dt: datetime) -> datetime:
    """Convert a timezone-aware datetime to IST. Raises on naive input --
    the honesty and quiet-hours rules both depend on knowing the real
    instant, so silently assuming a timezone would be a bug, not a
    convenience.
    """
    if dt.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    return dt.astimezone(IST)


def is_quiet(ts: datetime, quiet: QuietHours) -> bool:
    """True if the IST wall-clock time of ``ts`` falls inside the quiet
    window ``[start, end)``. Handles windows that wrap midnight (e.g.
    23:00-08:00). A degenerate window where start == end is treated as
    "never quiet".
    """
    t = to_ist(ts).timetz().replace(tzinfo=None)
    start, end = quiet.start, quiet.end

    if start == end:
        return False
    if start < end:
        return start <= t < end
    # Wraps midnight: quiet from `start` to 23:59:59.999999, then again
    # from 00:00 to just before `end`.
    return t >= start or t < end


def release_time(ts: datetime, quiet: QuietHours) -> datetime:
    """The next moment (as a UTC datetime) at which a notification held at
    ``ts`` should be delivered -- the next occurrence of ``quiet.end`` in
    IST, at or after ``ts``.

    Only meaningful when ``is_quiet(ts, quiet)`` is True; callers should not
    call this for a timestamp outside quiet hours.
    """
    ist_ts = to_ist(ts)
    end_today = ist_ts.replace(
        hour=quiet.end.hour,
        minute=quiet.end.minute,
        second=0,
        microsecond=0,
    )
    if ist_ts.time() < quiet.end:
        # Early-morning portion of a wrapped window (or inside a
        # non-wrapping window, which always satisfies t < end): today's
        # end boundary has not passed yet.
        release = end_today
    else:
        # Evening portion of a wrapped window (t >= start >= end):
        # the window's end boundary is tomorrow.
        release = end_today + timedelta(days=1)
    return release.astimezone(timezone.utc)


def schedule(ts: datetime, quiet: QuietHours) -> datetime:
    """Return the UTC delivery time for an event captured at ``ts``:
    immediately (``ts`` itself) if outside quiet hours, else the next
    release time.
    """
    if is_quiet(ts, quiet):
        return release_time(ts, quiet)
    return ts.astimezone(timezone.utc)
