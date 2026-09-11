"""The one HTTP client every adapter uses.

Everything that touches the network lives behind this class so that parsing
stays a pure function of bytes and can be tested offline (spec sections 6
and 13).

Three things in here are not decoration -- they are the difference between a
fashion sweep that returns offers and one that returns nothing at all
(measured 2026-09-12, recorded in `adapters/FASHION-NOTES.md` section 6):

1. a **complete, self-consistent Chrome identity** (User-Agent *and* the
   `sec-ch-ua*` client hints, built from one constant so they cannot drift --
   a Chrome 131 UA next to Chrome 128 hints is a louder bot signal than no
   hints at all);
2. a **per-host warm-up**: one GET of the home page with
   `Sec-Fetch-Site: none`, keeping the cookie jar, before the first real
   request; subsequent requests then carry a plausible `Referer` and
   `Sec-Fetch-Site: same-origin`;
3. **per-host pacing** from a declarative profile table.

With the stock client (no hints, no warm-up) Amazon returned 503 on all four
retry attempts -- 0 offers, `blocked`. With the hints and the warm-up the same
call returned 48 offers, `ok`.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import requests

from collectors.core.ratelimit import RateLimiter

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Browser identity. ONE source of truth.
#
# Everything below -- the User-Agent string and every `sec-ch-ua*` hint -- is
# derived from these three constants. Keeping them together is the point: a
# server that sees `Chrome/131` in the UA and `"Chromium";v="128"` in the hints
# knows immediately that it is not talking to Chrome.
# --------------------------------------------------------------------------
CHROME_MAJOR = "131"
CHROME_FULL = f"{CHROME_MAJOR}.0.0.0"
PLATFORM = "Windows"
PLATFORM_UA = "Windows NT 10.0; Win64; x64"

USER_AGENT = (
    f"Mozilla/5.0 ({PLATFORM_UA}) AppleWebKit/537.36 "
    f"(KHTML, like Gecko) Chrome/{CHROME_FULL} Safari/537.36"
)

# Chrome's own GREASE ordering: a fake brand, then Chromium, then the product.
# The major version here MUST equal the one in USER_AGENT; both come from
# CHROME_MAJOR so they cannot be edited apart.
SEC_CH_UA = (
    f'"Not_A Brand";v="24", "Chromium";v="{CHROME_MAJOR}", '
    f'"Google Chrome";v="{CHROME_MAJOR}"'
)

#: The full document-navigation header set Chrome sends on a cold request.
#: Measured working against Amazon.in, Flipkart and Myntra on 2026-09-12.
DEFAULT_HEADERS: dict[str, str] = {
    "User-Agent": USER_AGENT,
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,image/apng,*/*;q=0.8,"
        "application/signed-exchange;v=b3;q=0.7"
    ),
    "Accept-Language": "en-IN,en;q=0.9",
    # No `br`: brotli is not a hard dependency of the collector image, and
    # advertising an encoding we cannot decode is worse than omitting it.
    "Accept-Encoding": "gzip, deflate",
    "sec-ch-ua": SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": f'"{PLATFORM}"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

#: Headers that a warmed-up, same-origin navigation carries instead of the
#: cold-start values above. `Referer` is filled in per host.
WARMED_HEADERS: dict[str, str] = {"Sec-Fetch-Site": "same-origin"}

RETRY_STATUSES = frozenset({403, 408, 425, 429, 500, 502, 503, 504})


# --------------------------------------------------------------------------
# Per-host profiles
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class HostProfile:
    """Everything that varies per retailer, in one declarative place.

    Adding a retailer means adding a row here, never adding an `if host ==`
    branch inside the client.
    """

    #: Minimum seconds between requests to this host.
    delay: float
    #: Home page to GET once, before the first real request to this host.
    #: `None` disables the warm-up entirely for that host.
    warmup_url: str | None = None
    #: `Referer` sent on requests that follow the warm-up. Defaults to
    #: `warmup_url` when a warm-up is configured.
    referer: str | None = None
    #: Retry budget override. `None` means "use the client's RetryPolicy".
    attempts: int | None = None
    #: Extra/overriding headers for every request to this host.
    headers: Mapping[str, str] = field(default_factory=dict)
    #: Why the values above are what they are.
    note: str = ""

    def referer_for(self, host: str) -> str | None:
        if self.referer:
            return self.referer
        if self.warmup_url:
            return self.warmup_url
        return None


#: Hosts with no entry of their own get this.
DEFAULT_PROFILE = HostProfile(delay=1.0)

#: Measured 2026-09-11/12 against the live sites from a residential IP in
#: India. Every non-default value carries the measurement that produced it.
#: See `adapters/FASHION-NOTES.md` for the full write-up.
HOST_PROFILES: dict[str, HostProfile] = {
    # Quick commerce -------------------------------------------------------
    "blinkit.com": HostProfile(
        delay=1.5,  # tolerates ~1 req/s; 1.5 s is the comfortable floor
        # No warm-up: the category page serves full server-rendered state on a
        # cold request, and the adapter drives its own JSON pagination.
        note="1.5 s measured safe over a 650-product paginated sweep.",
    ),
    "www.bigbasket.com": HostProfile(
        delay=4.0,
        # 2.0 s produced sustained 429s from listing-svc on a 15-page sweep;
        # 4.0 s held. Measured 2026-09-12.
        # No warm-up here: BigBasketAdapter.ensure_location() already GETs the
        # home page as step 0 of its own four-call location handshake, and a
        # second home hit would only burn 4 s of the Actions budget.
        note="4.0 s held where 2.0 s earned sustained 429s (2026-09-12).",
    ),
    # Fashion --------------------------------------------------------------
    "www.myntra.com": HostProfile(
        delay=3.0,
        # Measured: back-to-back requests at 6-7 s gaps, ~10 requests, zero
        # throttling and zero blocks. No warm-up needed -- one plain cold GET
        # of /men-tshirts returns the full 1.4 MB `window.__myx` page.
        note="Never blocked across ~10 requests; 3.0 s matches the measurement.",
    ),
    "www.amazon.in": HostProfile(
        delay=8.0,
        # 3.0 s reliably earned a 503 bot wall; 8 s kept a warmed session alive
        # for an entire probe run. Measured 2026-09-12.
        warmup_url="https://www.amazon.in/",
        # The warm-up itself answers 202/2,012 bytes (a soft wall) but sets the
        # session cookie. Cold search with hints+warm-up: 200, 2.8 MB, 60 cards.
        # Without it: 503 on all four attempts, 0 offers.
        note="8 s pacing + home warm-up turned 0 offers/blocked into 48 offers/ok.",
    ),
    "www.flipkart.com": HostProfile(
        delay=30.0,
        # A second request inside ~30 s is throttled; the adapter's own floor is
        # 20 s and 30 s is what was measured clean.
        warmup_url="https://www.flipkart.com/",
        # Measured: home -> 403 reCAPTCHA wall, zero cookies, then 12 s later
        # the search with `Referer` + `Sec-Fetch-Site: same-origin` -> 200,
        # 885,445 bytes, 40 offers. The warm-up is expected to fail and is
        # swallowed; it is the Referer/same-origin pair that does the work.
        attempts=2,
        # The wall is an intermittent coin flip, not a rate limit, so four
        # attempts at 30 s pacing costs two minutes of the Actions budget for
        # almost no extra success rate. Fail soft (spec section 6) instead.
        note="Wall is intermittent, not a rate limit; Referer+same-origin is what works.",
    ),
}

#: Kept as a module-level name because adapters and tests read it directly.
#: Derived from the profile table so the two can never disagree.
DEFAULT_HOST_DELAYS: dict[str, float] = {
    host: profile.delay for host, profile in HOST_PROFILES.items()
}


def profile_for(host: str) -> HostProfile:
    """The profile for `host`, or `DEFAULT_PROFILE` if it has no entry."""
    return HOST_PROFILES.get((host or "").lower(), DEFAULT_PROFILE)


class HttpError(RuntimeError):
    """Raised when a request could not be completed after all retries.

    Adapters must not let this escape `sweep()`/`search()` -- see
    `adapters.base.BaseAdapter`.
    """

    def __init__(self, message: str, *, url: str, status: int | None = None) -> None:
        super().__init__(message)
        self.url = url
        self.status = status


@dataclass
class RetryPolicy:
    attempts: int = 4
    backoff_base: float = 2.0
    backoff_start: float = 2.0
    backoff_cap: float = 60.0
    jitter: float = 0.3

    def sleep_for(self, attempt: int, retry_after: float | None = None) -> float:
        """Seconds to wait before retry number `attempt` (1-based)."""
        if retry_after is not None:
            return min(max(retry_after, 0.0), self.backoff_cap)
        raw = self.backoff_start * (self.backoff_base ** (attempt - 1))
        raw = min(raw, self.backoff_cap)
        return raw * (1.0 + random.uniform(0.0, self.jitter))


@dataclass
class HttpClient:
    """Rate-limited, retrying HTTP client with a full browser identity.

    One `requests.Session` for the whole process, which is what gives cookie
    persistence: the warm-up's session cookie is still in the jar when the
    search request goes out, and that is half of why the Amazon search works.
    """

    session: requests.Session = field(default_factory=requests.Session)
    timeout: float = 30.0
    limiter: RateLimiter = field(
        default_factory=lambda: RateLimiter(default_delay=DEFAULT_PROFILE.delay,
                                            per_host=DEFAULT_HOST_DELAYS)
    )
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    sleeper: Callable[[float], None] = time.sleep
    #: Set False to skip every per-host warm-up (tests, or a dry run).
    warm_up_enabled: bool = True

    def __post_init__(self) -> None:
        # Overwrite, not setdefault: requests seeds a Session with its own
        # `Accept: */*` and `Accept-Encoding`, and those must not survive --
        # the browser identity is the whole point.
        self.session.headers.update(DEFAULT_HEADERS)
        self._warmed: set[str] = set()
        self._warm_lock = threading.Lock()

    # -- cookies ---------------------------------------------------------
    def set_cookies(self, cookies: Mapping[str, str], domain: str) -> None:
        for name, value in cookies.items():
            self.session.cookies.set(name, value, domain=domain, path="/")

    def cookie(self, name: str) -> str:
        for c in self.session.cookies:
            if c.name == name:
                return c.value or ""
        return ""

    # -- headers ---------------------------------------------------------
    def headers_for(self, host: str, extra: Mapping[str, str] | None = None) -> dict[str, str]:
        """The complete header set that would go out to `host` right now.

        Layered, lowest precedence first: the cold Chrome identity, then the
        warmed same-origin overlay (only once this host has been warmed up),
        then the host profile's own overlay, then whatever the caller passed.
        The caller wins -- BigBasket's API headers and Blinkit's lat/lon are
        deliberate and must not be clobbered.
        """
        host = (host or "").lower()
        profile = profile_for(host)
        headers: dict[str, str] = dict(DEFAULT_HEADERS)
        if host in self._warmed and profile.warmup_url:
            headers.update(WARMED_HEADERS)
            referer = profile.referer_for(host)
            if referer:
                headers["Referer"] = referer
            # A same-origin navigation is not a user-activated one.
            headers.pop("Sec-Fetch-User", None)
        headers.update(profile.headers)
        if extra:
            headers.update(extra)
        return headers

    # -- warm-up ---------------------------------------------------------
    def warm_up(self, host: str) -> bool:
        """Fetch `host`'s home page once per process. Returns True if it ran.

        Deliberately single-attempt and failure-swallowing: Flipkart's home
        page answers 403 about half the time and Amazon's answers 202, yet the
        request still plants the session cookie that the real request needs.
        Retrying a soft wall at 30 s pacing would only burn the Actions budget.
        """
        host = (host or "").lower()
        profile = profile_for(host)
        if not self.warm_up_enabled or not profile.warmup_url:
            return False
        with self._warm_lock:
            if host in self._warmed:
                return False
            # Marked *before* the request: once per host per process means
            # once, whether or not the home page answers 200.
            self._warmed.add(host)

        self.limiter.wait(host)
        try:
            response = self.session.request(
                "GET",
                profile.warmup_url,
                headers=dict(DEFAULT_HEADERS),  # cold: Sec-Fetch-Site: none, no Referer
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            log.warning("warm-up GET %s failed: %s", profile.warmup_url, exc)
        else:
            log.debug("warm-up GET %s -> HTTP %d", profile.warmup_url, response.status_code)
        return True

    # -- requests --------------------------------------------------------
    def get(self, url: str, **kwargs: Any) -> requests.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> requests.Response:
        return self.request("POST", url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> requests.Response:
        return self.request("PUT", url, **kwargs)

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        host = urlsplit(url).hostname or ""
        kwargs.setdefault("timeout", self.timeout)

        # Warm up before the first real request to this host, never after.
        self.warm_up(host)
        kwargs["headers"] = self.headers_for(host, kwargs.get("headers"))

        profile = profile_for(host)
        attempts = profile.attempts or self.retry.attempts
        last_status: int | None = None
        last_error: Exception | None = None

        for attempt in range(1, attempts + 1):
            self.limiter.wait(host)
            response: requests.Response | None = None
            try:
                response = self.session.request(method, url, **kwargs)
            except requests.RequestException as exc:  # network/DNS/TLS/timeout
                last_error, last_status = exc, None
                log.warning("%s %s failed (attempt %d/%d): %s",
                            method, url, attempt, attempts, exc)
            else:
                if response.status_code not in RETRY_STATUSES:
                    return response
                last_status, last_error = response.status_code, None
                log.warning("%s %s -> HTTP %d (attempt %d/%d)",
                            method, url, response.status_code, attempt, attempts)
                if attempt == attempts:
                    return response

            if attempt == attempts:
                break
            wait = self.retry.sleep_for(attempt, _retry_after(response))
            self.limiter.penalise(host, wait)
            self.sleeper(wait)

        raise HttpError(
            f"{method} {url} failed after {attempts} attempts"
            + (f" (last status {last_status})" if last_status else f" ({last_error})"),
            url=url,
            status=last_status,
        )


def _retry_after(response: requests.Response | None) -> float | None:
    if response is None:
        return None
    raw = response.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None
