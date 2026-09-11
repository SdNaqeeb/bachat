"""The only place collectors/push touches the network. Kept as a tiny
Protocol so tests can inject a fully-fake transport -- no real HTTP call
ever happens in a test.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class HttpResponse:
    status_code: int
    body: dict[str, Any]
    text: str = ""


class Transport(Protocol):
    def post(
        self,
        url: str,
        *,
        json: dict[str, Any] | None = None,
        data: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 10.0,
    ) -> HttpResponse: ...


class RequestsTransport:
    """Default production transport, backed by `requests`. Never imported
    or exercised by unit tests -- those inject a fake Transport instead.
    """

    def post(
        self,
        url: str,
        *,
        json: dict[str, Any] | None = None,
        data: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 10.0,
    ) -> HttpResponse:
        import requests  # imported lazily so tests never need it installed

        resp = requests.post(url, json=json, data=data, headers=headers, timeout=timeout)
        try:
            body = resp.json()
        except ValueError:
            body = {}
        return HttpResponse(status_code=resp.status_code, body=body, text=resp.text)
