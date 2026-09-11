"""Tests for the shared HTTP client, rate limiter and category seed.

Spec section 6: "Rate limit per host. Flipkart throttles after a single
request; the shared client enforces a per-retailer delay and exponential
backoff." A limiter that is never tested is a limiter that silently stops
working, so it is tested here with an injected clock -- no real sleeping, no
network.
"""

from __future__ import annotations

from email.message import Message as HTTPMessage
from types import SimpleNamespace

import pytest
import requests

from collectors.core import categories
from collectors.core.http import (
    CHROME_MAJOR,
    DEFAULT_HEADERS,
    DEFAULT_HOST_DELAYS,
    DEFAULT_PROFILE,
    HOST_PROFILES,
    SEC_CH_UA,
    USER_AGENT,
    HttpClient,
    HttpError,
    RetryPolicy,
    profile_for,
)
from collectors.core.ratelimit import RateLimiter
from collectors.core.types import Category, Filters, Location, Offer


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


# -- rate limiter -----------------------------------------------------------
def test_first_request_to_a_host_does_not_wait() -> None:
    clock = FakeClock()
    limiter = RateLimiter(default_delay=2.0, clock=clock.time, sleeper=clock.sleep)
    assert limiter.wait("blinkit.com") == 0.0
    assert clock.slept == []


def test_second_request_waits_the_configured_delay() -> None:
    clock = FakeClock()
    limiter = RateLimiter(default_delay=2.0, clock=clock.time, sleeper=clock.sleep)
    limiter.wait("blinkit.com")
    assert limiter.wait("blinkit.com") == pytest.approx(2.0)
    assert clock.slept == [2.0]


def test_delay_already_elapsed_means_no_wait() -> None:
    clock = FakeClock()
    limiter = RateLimiter(default_delay=2.0, clock=clock.time, sleeper=clock.sleep)
    limiter.wait("blinkit.com")
    clock.now += 5.0
    assert limiter.wait("blinkit.com") == 0.0


def test_hosts_are_paced_independently() -> None:
    clock = FakeClock()
    limiter = RateLimiter(default_delay=2.0, clock=clock.time, sleeper=clock.sleep)
    limiter.wait("blinkit.com")
    assert limiter.wait("www.bigbasket.com") == 0.0


def test_per_host_delay_overrides_the_default() -> None:
    clock = FakeClock()
    limiter = RateLimiter(
        default_delay=1.0,
        per_host={"www.flipkart.com": 30.0},
        clock=clock.time,
        sleeper=clock.sleep,
    )
    assert limiter.delay_for("www.flipkart.com") == 30.0
    assert limiter.delay_for("WWW.FLIPKART.COM") == 30.0
    assert limiter.delay_for("blinkit.com") == 1.0
    limiter.wait("www.flipkart.com")
    assert limiter.wait("www.flipkart.com") == pytest.approx(30.0)


def test_delay_is_configurable_at_runtime() -> None:
    clock = FakeClock()
    limiter = RateLimiter(default_delay=1.0, clock=clock.time, sleeper=clock.sleep)
    limiter.set_delay("blinkit.com", 7.0)
    limiter.wait("blinkit.com")
    assert limiter.wait("blinkit.com") == pytest.approx(7.0)


def test_flipkart_is_paced_hard_by_default() -> None:
    # Spec section 3: Flipkart's second request comes back as 787 bytes.
    assert DEFAULT_HOST_DELAYS["www.flipkart.com"] >= 20.0


def test_penalise_pushes_the_next_request_out() -> None:
    clock = FakeClock()
    limiter = RateLimiter(default_delay=1.0, clock=clock.time, sleeper=clock.sleep)
    limiter.wait("blinkit.com")
    limiter.penalise("blinkit.com", 10.0)
    assert limiter.wait("blinkit.com") == pytest.approx(11.0)


# -- retry policy -----------------------------------------------------------
def test_backoff_grows_exponentially() -> None:
    policy = RetryPolicy(backoff_start=2.0, backoff_base=2.0, jitter=0.0)
    assert [policy.sleep_for(n) for n in (1, 2, 3)] == [2.0, 4.0, 8.0]


def test_backoff_is_capped() -> None:
    policy = RetryPolicy(backoff_start=2.0, backoff_base=2.0, jitter=0.0, backoff_cap=5.0)
    assert policy.sleep_for(9) == 5.0


def test_retry_after_header_wins_over_backoff() -> None:
    policy = RetryPolicy(backoff_start=2.0, jitter=0.0)
    assert policy.sleep_for(1, retry_after=13.0) == 13.0


def test_jitter_stays_inside_its_band() -> None:
    policy = RetryPolicy(backoff_start=2.0, backoff_base=2.0, jitter=0.3)
    for _ in range(50):
        assert 2.0 <= policy.sleep_for(1) <= 2.6


# -- http client ------------------------------------------------------------
class FakeSession:
    """Stands in for requests.Session. Returns queued responses in order."""

    def __init__(self, outcomes: list[object]) -> None:
        self.outcomes = list(outcomes)
        self.headers: dict[str, str] = {}
        self.cookies = requests.cookies.RequestsCookieJar()
        self.calls: list[tuple[str, str, dict]] = []

    def request(self, method: str, url: str, **kwargs: object):
        self.calls.append((method, url, dict(kwargs)))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _response(status: int, headers: dict[str, str] | None = None) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response.url = "https://blinkit.com/cn/x"
    response.headers.update(headers or {})
    return response


def _client(outcomes: list[object], **kwargs: object) -> tuple[HttpClient, FakeSession, FakeClock]:
    session = FakeSession(outcomes)
    clock = FakeClock()
    client = HttpClient(
        session=session,  # type: ignore[arg-type]
        limiter=RateLimiter(default_delay=0.0, clock=clock.time, sleeper=clock.sleep),
        sleeper=clock.sleep,
        **kwargs,  # type: ignore[arg-type]
    )
    return client, session, clock


def test_the_client_sends_a_desktop_chrome_identity() -> None:
    client, session, _ = _client([_response(200)])
    assert "Chrome" in session.headers["User-Agent"] == USER_AGENT in session.headers["User-Agent"]
    assert session.headers["Accept-Language"] == "en-IN,en;q=0.9"
    assert "gzip" in session.headers["Accept-Encoding"]
    assert DEFAULT_HEADERS["User-Agent"] == USER_AGENT


def test_a_successful_request_is_returned_unchanged() -> None:
    client, session, _ = _client([_response(200)])
    assert client.get("https://blinkit.com/cn/x").status_code == 200
    assert len(session.calls) == 1


def test_a_timeout_is_applied() -> None:
    client, session, _ = _client([_response(200)])
    client.get("https://blinkit.com/cn/x")
    assert session.calls[0][2]["timeout"] == client.timeout


@pytest.mark.parametrize("status", [403, 429, 500, 502, 503])
def test_blocking_statuses_are_retried(status: int) -> None:
    client, session, clock = _client([_response(status), _response(200)])
    assert client.get("https://blinkit.com/cn/x").status_code == 200
    assert len(session.calls) == 2
    assert clock.slept, "a retry must back off before trying again"


def test_a_404_is_not_retried() -> None:
    client, session, _ = _client([_response(404)])
    assert client.get("https://blinkit.com/cn/x").status_code == 404
    assert len(session.calls) == 1


def test_retry_after_is_honoured() -> None:
    client, _, clock = _client(
        [_response(429, {"Retry-After": "12"}), _response(200)],
        retry=RetryPolicy(backoff_start=2.0, jitter=0.0),
    )
    client.get("https://blinkit.com/cn/x")
    assert clock.slept[0] == 12.0


def test_a_garbage_retry_after_falls_back_to_backoff() -> None:
    client, _, clock = _client(
        [_response(429, {"Retry-After": "soon"}), _response(200)],
        retry=RetryPolicy(backoff_start=2.0, jitter=0.0),
    )
    client.get("https://blinkit.com/cn/x")
    assert clock.slept[0] == 2.0


def test_the_last_blocked_response_is_returned_not_raised() -> None:
    client, session, _ = _client(
        [_response(429), _response(429)], retry=RetryPolicy(attempts=2, jitter=0.0)
    )
    assert client.get("https://blinkit.com/cn/x").status_code == 429
    assert len(session.calls) == 2


def test_network_errors_are_retried_then_raise_http_error() -> None:
    boom = requests.ConnectionError("dns")
    client, session, _ = _client([boom, boom], retry=RetryPolicy(attempts=2, jitter=0.0))
    with pytest.raises(HttpError) as excinfo:
        client.get("https://blinkit.com/cn/x")
    assert excinfo.value.status is None
    assert len(session.calls) == 2


def test_a_block_pushes_the_hosts_limiter_out_not_just_this_call() -> None:
    # The backoff is applied to the shared limiter, so a second adapter on the
    # same host inherits the penalty instead of walking straight into the block.
    client, _, clock = _client(
        [_response(429), _response(200)], retry=RetryPolicy(backoff_start=5.0, jitter=0.0)
    )
    other_host_free = client.limiter.wait("www.bigbasket.com")
    client.get("https://blinkit.com/cn/x")
    assert clock.slept == [5.0]
    assert other_host_free == 0.0


def test_cookies_round_trip() -> None:
    client, _, _ = _client([_response(200)])
    client.set_cookies({"_bb_pin_code": "560034"}, ".bigbasket.com")
    assert client.cookie("_bb_pin_code") == "560034"
    assert client.cookie("missing") == ""


# -- category seed ----------------------------------------------------------
def test_both_retailers_seed_the_same_five_slugs() -> None:
    blinkit = {c.slug for c in categories.for_retailer("blinkit")}
    bigbasket = {c.slug for c in categories.for_retailer("bigbasket")}
    assert blinkit == bigbasket == set(categories.QUICK_SLUGS)


def test_blinkit_category_ids_carry_both_category_levels() -> None:
    for category in categories.for_retailer("blinkit"):
        assert "/cid/" in category.id
        assert category.id.split("/cid/")[1].count("/") == 1


def test_every_seeded_category_is_quick_mode() -> None:
    for retailer in ("blinkit", "bigbasket"):
        assert all(c.mode == "quick" for c in categories.for_retailer(retailer))


def test_lookup_by_slug() -> None:
    assert categories.by_slug("bigbasket", "snacks").id == "snacks-branded-foods"
    assert categories.by_slug("bigbasket", "nope") is None
    assert categories.for_retailer("zepto") == ()


def test_enabled_filters_to_the_users_categories() -> None:
    enabled = categories.enabled("blinkit", ["snacks", "dairy"])
    assert [c.slug for c in enabled] == ["snacks", "dairy"]
    assert len(categories.enabled("blinkit")) == 5


# -- filters ----------------------------------------------------------------
def _offer(**kwargs: object) -> Offer:
    base = dict(ext_id="1", name="Amul Taaza", price=30.0, mrp=32.0, in_stock=True,
                url="https://x/1", category="dairy", brand="Amul", size="500 ml")
    base.update(kwargs)
    return Offer(**base)  # type: ignore[arg-type]


def test_no_filters_is_a_passthrough() -> None:
    assert Filters().matches(_offer())


def test_max_price_filter() -> None:
    assert Filters(max_price=30.0).matches(_offer())
    assert not Filters(max_price=29.0).matches(_offer())


def test_brand_filter_is_case_insensitive_and_substring() -> None:
    assert Filters(brands=("amul",)).matches(_offer())
    assert not Filters(brands=("nestle",)).matches(_offer())


def test_size_filter_is_exact() -> None:
    assert Filters(sizes=("500 ML",)).matches(_offer())
    assert not Filters(sizes=("1 L",)).matches(_offer())


def test_location_reports_whether_it_has_coordinates() -> None:
    assert Location(lat=1.0, lon=2.0).has_coords
    assert not Location(pincode="560034").has_coords


def test_offer_is_frozen() -> None:
    with pytest.raises(Exception):
        _offer().price = 1.0  # type: ignore[misc]


def test_category_is_hashable_so_sweeps_can_dedupe() -> None:
    assert len({Category(id="a", slug="s", label="A"), Category(id="a", slug="s", label="A")}) == 1


# ===========================================================================
# Browser identity, per-host profiles, warm-up and cookie persistence.
#
# Spec section 6 and `adapters/FASHION-NOTES.md` section 6: with the stock
# client (no `sec-ch-ua*` hints, no warm-up) an Amazon search answered 503 on
# all four retry attempts -- 0 offers, `blocked`. With the hints and one
# warm-up GET of the home page the same call returned 48 offers, `ok`.
# Flipkart needed the hints plus `Referer` + `Sec-Fetch-Site: same-origin`.
# Everything below pins that behaviour, entirely offline.
# ===========================================================================

EXPECTED_HEADER_NAMES = frozenset({
    "User-Agent",
    "Accept",
    "Accept-Language",
    "Accept-Encoding",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "Sec-Fetch-Dest",
    "Sec-Fetch-Mode",
    "Sec-Fetch-Site",
    "Sec-Fetch-User",
    "Upgrade-Insecure-Requests",
})


def test_the_default_header_set_is_exactly_the_chrome_navigation_set() -> None:
    assert set(DEFAULT_HEADERS) == EXPECTED_HEADER_NAMES


def test_client_hints_agree_with_the_user_agent() -> None:
    # A Chrome 131 UA next to Chrome 128 hints is a louder bot signal than
    # sending no hints at all, so both are derived from CHROME_MAJOR.
    assert f"Chrome/{CHROME_MAJOR}." in DEFAULT_HEADERS["User-Agent"]
    assert f'"Chromium";v="{CHROME_MAJOR}"' in DEFAULT_HEADERS["sec-ch-ua"]
    assert f'"Google Chrome";v="{CHROME_MAJOR}"' in DEFAULT_HEADERS["sec-ch-ua"]
    assert DEFAULT_HEADERS["sec-ch-ua-mobile"] == "?0"  # the UA is a desktop UA
    assert DEFAULT_HEADERS["sec-ch-ua-platform"] == '"Windows"'
    assert "Windows NT" in DEFAULT_HEADERS["User-Agent"]
    assert DEFAULT_HEADERS["Accept-Language"] == "en-IN,en;q=0.9"


def test_every_request_carries_the_whole_header_set() -> None:
    client, session, _ = _client([_response(200)])
    client.get("https://blinkit.com/cn/x")
    sent = session.calls[0][2]["headers"]
    assert EXPECTED_HEADER_NAMES <= set(sent)
    assert sent["User-Agent"] == USER_AGENT
    assert sent["sec-ch-ua"] == SEC_CH_UA


def test_caller_headers_win_over_the_defaults() -> None:
    # BigBasket's X-* API headers and Blinkit's lat/lon are deliberate and
    # must not be clobbered by the shared identity.
    client, session, _ = _client([_response(200)])
    client.get("https://blinkit.com/cn/x", headers={"lat": "12.9", "Sec-Fetch-Dest": "empty"})
    sent = session.calls[0][2]["headers"]
    assert sent["lat"] == "12.9"
    assert sent["Sec-Fetch-Dest"] == "empty"
    assert sent["User-Agent"] == USER_AGENT


# -- per-host profiles ------------------------------------------------------
def test_amazon_is_paced_at_the_measured_eight_seconds() -> None:
    # Measured 2026-09-12: 3 s reliably earned a 503; 8 s held for a whole run.
    assert HOST_PROFILES["www.amazon.in"].delay >= 8.0
    assert DEFAULT_HOST_DELAYS["www.amazon.in"] >= 8.0


def test_host_delays_are_derived_from_the_profile_table() -> None:
    assert DEFAULT_HOST_DELAYS == {h: p.delay for h, p in HOST_PROFILES.items()}


def test_the_limiter_takes_its_delays_from_the_profile_table() -> None:
    client = HttpClient()
    for host, profile in HOST_PROFILES.items():
        assert client.limiter.delay_for(host) == profile.delay
    assert client.limiter.delay_for("example.invalid") == DEFAULT_PROFILE.delay


def test_unknown_hosts_fall_back_to_the_default_profile() -> None:
    assert profile_for("example.invalid") is DEFAULT_PROFILE
    assert profile_for("WWW.AMAZON.IN") is HOST_PROFILES["www.amazon.in"]


def test_every_profile_documents_its_measurement() -> None:
    for host, profile in HOST_PROFILES.items():
        assert profile.note, f"{host} has no measurement note"


def test_a_per_host_retry_budget_overrides_the_policy() -> None:
    # Flipkart's wall is an intermittent coin flip, not a rate limit: four
    # attempts at 30 s pacing costs two minutes for almost no extra success.
    assert HOST_PROFILES["www.flipkart.com"].attempts == 2
    client, session, _ = _client([_response(403), _response(403), _response(403)])
    assert client.get("https://www.flipkart.com/search?q=x").status_code == 403
    # One warm-up plus two attempts, not one plus four.
    assert len(session.calls) == 3


# -- warm-up ----------------------------------------------------------------
def test_warm_up_precedes_the_first_real_request_to_a_warmed_host() -> None:
    # The real Amazon warm-up answers 202/2,012 bytes -- a soft wall that
    # still plants the session cookie.
    client, session, _ = _client([_response(202), _response(200)])
    client.get("https://www.amazon.in/s?k=running+shoes")
    assert [c[1] for c in session.calls] == [
        "https://www.amazon.in/",
        "https://www.amazon.in/s?k=running+shoes",
    ]


def test_warm_up_happens_once_per_host_per_process() -> None:
    client, session, _ = _client([_response(202)] + [_response(200)] * 3)
    for _ in range(3):
        client.get("https://www.amazon.in/s?k=running+shoes")
    assert [c[1] for c in session.calls].count("https://www.amazon.in/") == 1
    assert len(session.calls) == 4


def test_warm_up_is_per_host_not_global() -> None:
    client, session, _ = _client(
        [_response(202), _response(200), _response(403), _response(200)]
    )
    client.get("https://www.amazon.in/s?k=x")
    client.get("https://www.flipkart.com/search?q=x")
    assert [c[1] for c in session.calls] == [
        "https://www.amazon.in/",
        "https://www.amazon.in/s?k=x",
        "https://www.flipkart.com/",
        "https://www.flipkart.com/search?q=x",
    ]


def test_hosts_without_a_warmup_url_are_not_warmed() -> None:
    # Blinkit serves full state on a cold GET, Myntra likewise, and
    # BigBasketAdapter already GETs the home page itself as step 0 of its
    # location handshake -- a second hit would only burn Actions minutes.
    for host in ("blinkit.com", "www.bigbasket.com", "www.myntra.com"):
        assert HOST_PROFILES[host].warmup_url is None
    client, session, _ = _client([_response(200)])
    client.get("https://blinkit.com/cn/x")
    assert len(session.calls) == 1


def test_sec_fetch_site_and_referer_flip_after_the_warm_up() -> None:
    client, session, _ = _client([_response(202), _response(200)])
    client.get("https://www.amazon.in/s?k=running+shoes")
    warm, real = session.calls[0][2]["headers"], session.calls[1][2]["headers"]
    # Cold: a typed-in navigation. No Referer at all.
    assert warm["Sec-Fetch-Site"] == "none"
    assert warm["Sec-Fetch-User"] == "?1"
    assert "Referer" not in warm
    # Warmed: a click from the home page.
    assert real["Sec-Fetch-Site"] == "same-origin"
    assert real["Referer"] == "https://www.amazon.in/"
    assert "Sec-Fetch-User" not in real
    # The identity itself never changes between the two.
    assert warm["User-Agent"] == real["User-Agent"] == USER_AGENT
    assert warm["sec-ch-ua"] == real["sec-ch-ua"] == SEC_CH_UA


def test_flipkart_gets_the_referer_and_same_origin_pair_that_worked() -> None:
    client, session, _ = _client([_response(403), _response(200)])
    client.get("https://www.flipkart.com/search?q=running%20shoes")
    sent = session.calls[1][2]["headers"]
    assert sent["Referer"] == "https://www.flipkart.com/"
    assert sent["Sec-Fetch-Site"] == "same-origin"


def test_an_unwarmed_host_sends_no_referer_of_ours() -> None:
    client, session, _ = _client([_response(200)])
    client.get("https://blinkit.com/cn/x")
    sent = session.calls[0][2]["headers"]
    assert "Referer" not in sent
    assert sent["Sec-Fetch-Site"] == "none"


def test_a_failed_warm_up_does_not_abort_the_real_request() -> None:
    # Flipkart's home page answers 403 about half the time; the search that
    # followed it still returned 200 and 40 offers (FASHION-NOTES 3.1).
    client, session, _ = _client([requests.ConnectionError("reset"), _response(200)])
    assert client.get("https://www.flipkart.com/search?q=x").status_code == 200
    assert len(session.calls) == 2


def test_a_failed_warm_up_is_still_only_tried_once() -> None:
    client, session, _ = _client(
        [requests.ConnectionError("reset"), _response(200), _response(200)]
    )
    client.get("https://www.flipkart.com/search?q=x")
    client.get("https://www.flipkart.com/search?q=y")
    assert [c[1] for c in session.calls].count("https://www.flipkart.com/") == 1


def test_warm_up_can_be_disabled() -> None:
    client, session, _ = _client([_response(200)], warm_up_enabled=False)
    client.get("https://www.amazon.in/s?k=x")
    assert len(session.calls) == 1
    assert session.calls[0][2]["headers"]["Sec-Fetch-Site"] == "none"


def test_the_warm_up_is_paced_by_the_limiter_like_any_other_request() -> None:
    clock = FakeClock()
    session = FakeSession([_response(202), _response(200)])
    client = HttpClient(
        session=session,  # type: ignore[arg-type]
        limiter=RateLimiter(
            default_delay=1.0,
            per_host=DEFAULT_HOST_DELAYS,
            clock=clock.time,
            sleeper=clock.sleep,
        ),
        sleeper=clock.sleep,
    )
    client.get("https://www.amazon.in/s?k=x")
    # Warm-up fires immediately; the search waits Amazon's measured 8 s.
    assert clock.slept == [pytest.approx(8.0)]


def test_the_existing_contract_survives_on_a_warmed_host() -> None:
    """Backoff, Retry-After and penalise() still behave with a warm-up in front."""
    clock = FakeClock()
    session = FakeSession(
        [_response(202), _response(429, {"Retry-After": "12"}), _response(200)]
    )
    client = HttpClient(
        session=session,  # type: ignore[arg-type]
        limiter=RateLimiter(default_delay=0.0, clock=clock.time, sleeper=clock.sleep),
        sleeper=clock.sleep,
        retry=RetryPolicy(backoff_start=2.0, jitter=0.0),
    )
    # penalise() must still push the *shared* limiter out, so a second adapter
    # on the same host inherits the penalty instead of walking into the block.
    penalties: list[tuple[str, float]] = []
    client.limiter.penalise = lambda host, secs: penalties.append((host, secs))  # type: ignore[method-assign]

    assert client.get("https://www.amazon.in/s?k=x").status_code == 200
    assert [c[1] for c in session.calls] == [
        "https://www.amazon.in/",
        "https://www.amazon.in/s?k=x",
        "https://www.amazon.in/s?k=x",
    ]
    assert clock.slept == [12.0]  # Retry-After beat the backoff
    assert penalties == [("www.amazon.in", 12.0)]


# -- cookie persistence -----------------------------------------------------
class _RecordingAdapter(requests.adapters.BaseAdapter):
    """An offline requests transport: answers 200, can set a cookie, no socket."""

    def __init__(self) -> None:
        self.next_cookie: tuple[str, str] | None = None
        self.sent_cookie_headers: list[str] = []

    def send(self, request, **kwargs):  # type: ignore[override]
        self.sent_cookie_headers.append(request.headers.get("Cookie", ""))
        message = HTTPMessage()
        if self.next_cookie:
            name, value = self.next_cookie
            message["Set-Cookie"] = f"{name}={value}; Domain=.amazon.in; Path=/"
        response = requests.Response()
        response.status_code = 200
        response.url = request.url
        response.request = request
        response._content = b""
        response.raw = SimpleNamespace(_original_response=SimpleNamespace(msg=message))
        return response

    def close(self) -> None:  # pragma: no cover - nothing to close
        pass


def test_cookies_persist_across_requests_to_the_same_host() -> None:
    """One session, one jar: the warm-up's cookie is still there for the search."""
    client = HttpClient(warm_up_enabled=False, limiter=RateLimiter(default_delay=0.0))
    transport = _RecordingAdapter()
    client.session.mount("https://", transport)

    transport.next_cookie = ("session-id", "257-1234567-0000000")
    client.get("https://www.amazon.in/")
    assert client.cookie("session-id") == "257-1234567-0000000"

    transport.next_cookie = None
    client.get("https://www.amazon.in/s?k=running+shoes")
    assert transport.sent_cookie_headers == ["", "session-id=257-1234567-0000000"]


def test_the_warm_up_cookie_reaches_the_real_request() -> None:
    client = HttpClient(limiter=RateLimiter(default_delay=0.0))
    transport = _RecordingAdapter()
    client.session.mount("https://", transport)
    transport.next_cookie = ("session-id", "abc")

    client.get("https://www.amazon.in/s?k=x")
    # Two requests went out (warm-up then search) and the second carried the
    # cookie the first was given.
    assert len(transport.sent_cookie_headers) == 2
    assert transport.sent_cookie_headers[1] == "session-id=abc"
