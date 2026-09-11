"""Per-host request pacing.

Flipkart throttles a second request within seconds of the first, so pacing is
not decoration: it is what keeps a sweep returning data. The limiter is shared
by every adapter through `core.http.HttpClient` and is configurable per host.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping


class RateLimiter:
    """Enforce a minimum interval between requests to the same host.

    Thread-safe: a sweep may fan out across adapters, and two adapters can
    share a host (e.g. `blinkit.com` for both the HTML page and the layout
    API).
    """

    def __init__(
        self,
        default_delay: float = 1.0,
        per_host: Mapping[str, float] | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self.default_delay = float(default_delay)
        self._per_host: dict[str, float] = {k.lower(): float(v) for k, v in (per_host or {}).items()}
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()
        self._clock = clock
        self._sleeper = sleeper

    def delay_for(self, host: str) -> float:
        return self._per_host.get(host.lower(), self.default_delay)

    def set_delay(self, host: str, delay: float) -> None:
        with self._lock:
            self._per_host[host.lower()] = float(delay)

    def wait(self, host: str) -> float:
        """Block until the host is due again. Returns the seconds slept."""
        host = host.lower()
        delay = self.delay_for(host)
        with self._lock:
            now = self._clock()
            last = self._last.get(host)
            sleep_for = 0.0 if last is None else max(0.0, delay - (now - last))
            # Reserve the slot before releasing the lock so two threads racing
            # on the same host queue up instead of both firing immediately.
            self._last[host] = now + sleep_for
        if sleep_for > 0:
            self._sleeper(sleep_for)
        return sleep_for

    def penalise(self, host: str, seconds: float) -> None:
        """Push a host's next-allowed time out by `seconds` after a block."""
        host = host.lower()
        with self._lock:
            base = max(self._last.get(host, self._clock()), self._clock())
            self._last[host] = base + max(0.0, float(seconds))
