"""Mint an OAuth2 access token for FCM HTTP v1 from a service-account key,
via a self-signed JWT exchanged at Google's token endpoint (spec section 10).

No Firebase Admin SDK, no google-auth dependency -- just PyJWT (already a
project dependency) plus one HTTP POST through the injectable Transport.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Callable

import jwt

from collectors.push.transport import Transport

FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
JWT_LIFETIME_SECONDS = 3600


@dataclass(frozen=True)
class ServiceAccount:
    project_id: str
    client_email: str
    private_key: str
    token_uri: str = DEFAULT_TOKEN_URI

    @staticmethod
    def from_json(raw: str) -> "ServiceAccount":
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("service account JSON is not valid JSON") from exc

        missing = [k for k in ("project_id", "client_email", "private_key") if not data.get(k)]
        if missing:
            raise ValueError(f"service account JSON missing required fields: {missing}")

        return ServiceAccount(
            project_id=data["project_id"],
            client_email=data["client_email"],
            private_key=data["private_key"],
            token_uri=data.get("token_uri", DEFAULT_TOKEN_URI),
        )


class AuthError(Exception):
    """Raised when the token endpoint rejects our JWT outright (bad key,
    revoked service account, clock skew). Distinct from a transient network
    failure -- callers should not silently retry-forever on this.
    """


def build_assertion_jwt(sa: ServiceAccount, *, now: int | None = None) -> str:
    iat = now if now is not None else int(time.time())
    exp = iat + JWT_LIFETIME_SECONDS
    claims = {
        "iss": sa.client_email,
        "scope": FCM_SCOPE,
        "aud": sa.token_uri,
        "iat": iat,
        "exp": exp,
    }
    return jwt.encode(claims, sa.private_key, algorithm="RS256")


def fetch_access_token(sa: ServiceAccount, transport: Transport, *, now: int | None = None) -> tuple[str, int]:
    """Return (access_token, expires_at_epoch_seconds)."""
    assertion = build_assertion_jwt(sa, now=now)
    resp = transport.post(
        sa.token_uri,
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    if resp.status_code != 200:
        raise AuthError(f"token endpoint returned {resp.status_code}: {resp.text or resp.body}")

    access_token = resp.body.get("access_token")
    expires_in = resp.body.get("expires_in", 3600)
    if not access_token:
        raise AuthError(f"token endpoint response missing access_token: {resp.body}")

    issued_at = now if now is not None else int(time.time())
    return access_token, issued_at + int(expires_in)


class AccessTokenCache:
    """Caches the access token in memory for the life of one job run and
    refreshes it when it is close to expiring (or on demand after a 401).
    """

    def __init__(self, sa: ServiceAccount, transport: Transport, *, clock: Callable[[], int] = lambda: int(time.time())):
        self._sa = sa
        self._transport = transport
        self._clock = clock
        self._token: str | None = None
        self._expires_at: int = 0

    def get(self, *, force_refresh: bool = False) -> str:
        now = self._clock()
        # Refresh a little early (60s) to avoid racing expiry mid-request.
        if force_refresh or self._token is None or now >= self._expires_at - 60:
            self._token, self._expires_at = fetch_access_token(self._sa, self._transport, now=now)
        return self._token
