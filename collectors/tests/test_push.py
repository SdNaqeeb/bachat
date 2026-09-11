"""Tests for collectors/push. All network access is mocked -- FakeTransport
below never makes a real HTTP call, and RequestsTransport (the only place
that imports `requests`) is never exercised here.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from collectors.push.auth import (
    AccessTokenCache,
    AuthError,
    ServiceAccount,
    build_assertion_jwt,
    fetch_access_token,
)
from collectors.push.models import PushMessage, SendOutcome, channel_id_for
from collectors.push.sender import FCMSender, build_message_body
from collectors.push.transport import HttpResponse


# ---------------------------------------------------------------------------
# Fixtures / fakes
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def keypair() -> tuple[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


@pytest.fixture()
def service_account(keypair: tuple[str, str]) -> ServiceAccount:
    private_pem, _ = keypair
    return ServiceAccount(
        project_id="bachat-prod",
        client_email="collector@bachat-prod.iam.gserviceaccount.com",
        private_key=private_pem,
    )


@dataclass
class FakeTransport:
    """Replays a scripted sequence of responses per URL, recording every
    call it receives so tests can assert on request shape and call count.
    """

    responses: dict[str, list[HttpResponse]] = field(default_factory=dict)
    calls: list[dict] = field(default_factory=list)

    def post(self, url, *, json=None, data=None, headers=None, timeout=10.0):
        self.calls.append({"url": url, "json": json, "data": data, "headers": headers})
        queue = self.responses.get(url)
        if not queue:
            raise AssertionError(f"no scripted response left for {url}")
        return queue.pop(0) if len(queue) > 1 else queue[0]


def make_cache(sa: ServiceAccount, transport, clock=lambda: 1000) -> AccessTokenCache:
    return AccessTokenCache(sa, transport, clock=clock)


TOKEN_URL = "https://oauth2.googleapis.com/token"
SEND_URL = "https://fcm.googleapis.com/v1/projects/bachat-prod/messages:send"


# ---------------------------------------------------------------------------
# ServiceAccount parsing
# ---------------------------------------------------------------------------


def test_service_account_from_json_parses_fields(keypair: tuple[str, str]) -> None:
    private_pem, _ = keypair
    raw = json.dumps(
        {
            "project_id": "bachat-prod",
            "client_email": "collector@bachat-prod.iam.gserviceaccount.com",
            "private_key": private_pem,
        }
    )
    sa = ServiceAccount.from_json(raw)
    assert sa.project_id == "bachat-prod"
    assert sa.token_uri == "https://oauth2.googleapis.com/token"


def test_service_account_from_json_rejects_missing_fields() -> None:
    with pytest.raises(ValueError):
        ServiceAccount.from_json(json.dumps({"project_id": "x"}))


def test_service_account_from_json_rejects_invalid_json() -> None:
    with pytest.raises(ValueError):
        ServiceAccount.from_json("not json")


# ---------------------------------------------------------------------------
# JWT assertion
# ---------------------------------------------------------------------------


def test_build_assertion_jwt_claims(service_account: ServiceAccount, keypair: tuple[str, str]) -> None:
    _, public_pem = keypair
    token = build_assertion_jwt(service_account, now=1_000_000)
    claims = jwt.decode(
        token,
        public_pem,
        algorithms=["RS256"],
        audience=service_account.token_uri,
        options={"verify_exp": False},
    )
    assert claims["iss"] == service_account.client_email
    assert claims["scope"] == "https://www.googleapis.com/auth/firebase.messaging"
    assert claims["iat"] == 1_000_000
    assert claims["exp"] == 1_000_000 + 3600


# ---------------------------------------------------------------------------
# Token exchange + caching
# ---------------------------------------------------------------------------


def test_fetch_access_token_success(service_account: ServiceAccount) -> None:
    transport = FakeTransport(
        responses={TOKEN_URL: [HttpResponse(200, {"access_token": "tok-1", "expires_in": 3600})]}
    )
    token, expires_at = fetch_access_token(service_account, transport, now=1000)
    assert token == "tok-1"
    assert expires_at == 1000 + 3600


def test_fetch_access_token_failure_raises_auth_error(service_account: ServiceAccount) -> None:
    transport = FakeTransport(
        responses={TOKEN_URL: [HttpResponse(400, {"error": "invalid_grant"}, text="invalid_grant")]}
    )
    with pytest.raises(AuthError):
        fetch_access_token(service_account, transport, now=1000)


def test_access_token_cache_reuses_token_until_near_expiry(service_account: ServiceAccount) -> None:
    calls = {"n": 0}

    class CountingTransport(FakeTransport):
        def post(self, *args, **kwargs):
            calls["n"] += 1
            return HttpResponse(200, {"access_token": f"tok-{calls['n']}", "expires_in": 3600})

    now = {"t": 1000}
    cache = make_cache(service_account, CountingTransport(), clock=lambda: now["t"])

    assert cache.get() == "tok-1"
    assert cache.get() == "tok-1"  # cached, no second call
    assert calls["n"] == 1

    now["t"] = 1000 + 3600 - 30  # inside the 60s early-refresh window
    assert cache.get() == "tok-2"
    assert calls["n"] == 2


def test_access_token_cache_force_refresh(service_account: ServiceAccount) -> None:
    calls = {"n": 0}

    class CountingTransport(FakeTransport):
        def post(self, *args, **kwargs):
            calls["n"] += 1
            return HttpResponse(200, {"access_token": f"tok-{calls['n']}", "expires_in": 3600})

    cache = make_cache(service_account, CountingTransport())
    assert cache.get() == "tok-1"
    assert cache.get(force_refresh=True) == "tok-2"


# ---------------------------------------------------------------------------
# Message shape
# ---------------------------------------------------------------------------


def test_channel_id_for_sanitizes_category() -> None:
    assert channel_id_for("Fashion Tops") == "deals_fashion_tops"
    assert channel_id_for("dairy") == "deals_dairy"


def test_build_message_body_shape() -> None:
    msg = PushMessage(
        token="device-token",
        title="30-day low",
        body="Amul Taaza 500ml — ₹42",
        category="dairy",
        data={"product_id": "p1"},
    )
    body = build_message_body(msg)
    m = body["message"]
    assert m["token"] == "device-token"
    assert m["notification"] == {"title": "30-day low", "body": "Amul Taaza 500ml — ₹42"}
    assert m["android"]["priority"] == "high"
    assert m["android"]["notification"]["channel_id"] == "deals_dairy"
    assert m["data"] == {"product_id": "p1"}


# ---------------------------------------------------------------------------
# Sender: success, permanent failure, transient retry, 401 refresh
# ---------------------------------------------------------------------------


def _msg(token: str = "device-token") -> PushMessage:
    return PushMessage(token=token, title="t", body="b", category="dairy", data={})


def _cache_with_fixed_token(token: str = "tok") -> AccessTokenCache:
    class StubCache(AccessTokenCache):
        def __init__(self):
            pass

        def get(self, *, force_refresh: bool = False) -> str:
            return token

    return StubCache()


def test_sender_success() -> None:
    transport = FakeTransport(responses={SEND_URL: [HttpResponse(200, {"name": "projects/x/messages/1"})]})
    sender = FCMSender(project_id="bachat-prod", token_cache=_cache_with_fixed_token(), transport=transport)
    result = sender.send(_msg())
    assert result.outcome == SendOutcome.SENT
    assert len(transport.calls) == 1
    assert transport.calls[0]["headers"]["Authorization"] == "Bearer tok"


def test_sender_permanent_failure_does_not_retry() -> None:
    error_body = {"error": {"details": [{"errorCode": "UNREGISTERED"}]}}
    transport = FakeTransport(responses={SEND_URL: [HttpResponse(404, error_body)] * 5})
    sender = FCMSender(
        project_id="bachat-prod",
        token_cache=_cache_with_fixed_token(),
        transport=transport,
        sleep=lambda s: None,
    )
    result = sender.send(_msg())
    assert result.outcome == SendOutcome.PERMANENT_FAILURE
    assert len(transport.calls) == 1  # no retry wasted on a dead token


def test_sender_transient_failure_retries_then_reports_transient() -> None:
    error_body = {"error": {"details": [{"errorCode": "UNAVAILABLE"}]}}
    transport = FakeTransport(responses={SEND_URL: [HttpResponse(503, error_body)] * 5})
    sleeps: list[float] = []
    sender = FCMSender(
        project_id="bachat-prod",
        token_cache=_cache_with_fixed_token(),
        transport=transport,
        max_attempts=3,
        backoff_seconds=1.0,
        sleep=sleeps.append,
    )
    result = sender.send(_msg())
    assert result.outcome == SendOutcome.TRANSIENT_FAILURE
    assert len(transport.calls) == 3
    assert sleeps == [1.0, 2.0]  # exponential backoff, one fewer than attempts


def test_sender_recovers_after_transient_then_success() -> None:
    error_body = {"error": {"details": [{"errorCode": "INTERNAL"}]}}
    transport = FakeTransport(
        responses={
            SEND_URL: [
                HttpResponse(500, error_body),
                HttpResponse(200, {"name": "ok"}),
            ]
        }
    )
    sender = FCMSender(
        project_id="bachat-prod",
        token_cache=_cache_with_fixed_token(),
        transport=transport,
        max_attempts=3,
        sleep=lambda s: None,
    )
    result = sender.send(_msg())
    assert result.outcome == SendOutcome.SENT
    assert len(transport.calls) == 2


def test_sender_401_forces_token_refresh_and_retries() -> None:
    calls = {"n": 0}

    class RefreshTrackingCache(AccessTokenCache):
        def __init__(self):
            pass

        def get(self, *, force_refresh: bool = False):
            calls["n"] += 1
            if force_refresh:
                return "fresh-token"
            return "stale-token"

    transport = FakeTransport(
        responses={
            SEND_URL: [
                HttpResponse(401, {"error": {"message": "expired token"}}),
                HttpResponse(200, {"name": "ok"}),
            ]
        }
    )
    sender = FCMSender(
        project_id="bachat-prod",
        token_cache=RefreshTrackingCache(),
        transport=transport,
        max_attempts=3,
        sleep=lambda s: None,
    )
    result = sender.send(_msg())
    assert result.outcome == SendOutcome.SENT
    assert transport.calls[0]["headers"]["Authorization"] == "Bearer stale-token"
    assert transport.calls[1]["headers"]["Authorization"] == "Bearer fresh-token"


def test_sender_unknown_error_code_treated_as_transient_not_dropped() -> None:
    """An error code we don't recognise must never be silently treated as
    permanent -- losing a device registration on a false positive is worse
    than one extra retry.
    """
    error_body = {"error": {"details": [{"errorCode": "SOME_NEW_CODE_GOOGLE_ADDS_LATER"}]}}
    transport = FakeTransport(responses={SEND_URL: [HttpResponse(500, error_body)] * 5})
    sender = FCMSender(
        project_id="bachat-prod",
        token_cache=_cache_with_fixed_token(),
        transport=transport,
        max_attempts=2,
        sleep=lambda s: None,
    )
    result = sender.send(_msg())
    assert result.outcome == SendOutcome.TRANSIENT_FAILURE
