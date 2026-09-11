"""Shared test fixtures.

Every test in this package runs offline. `no_network` is autouse and fails any
test that tries to open a socket, which is how spec section 13's "no network in
CI" rule is enforced rather than merely intended.
"""

from __future__ import annotations

import json
import socket
import sys
from pathlib import Path
from typing import Any

import pytest

COLLECTORS_ROOT = Path(__file__).resolve().parents[1]
if str(COLLECTORS_ROOT) not in sys.path:
    sys.path.insert(0, str(COLLECTORS_ROOT))

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="session")
def fixture_dir() -> Path:
    return FIXTURE_DIR


def read_fixture(name: str) -> str:
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


def read_json_fixture(name: str) -> Any:
    return json.loads(read_fixture(name))


@pytest.fixture
def load_text():
    return read_fixture


@pytest.fixture
def load_json():
    return read_json_fixture


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hard-fail any test that reaches for the network."""

    def _blocked(*args: object, **kwargs: object) -> None:
        raise AssertionError("network access is not allowed in collector tests")

    monkeypatch.setattr(socket, "create_connection", _blocked)
    monkeypatch.setattr(socket.socket, "connect", _blocked)
