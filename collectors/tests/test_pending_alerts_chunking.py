"""The held-alert queue is written in chunks, not one enormous request.

A real sweep held 5,453 alerts and lost every one of them:

    pending_alerts_save_failed  SSLWantWriteError on POST /api/alerts/pending

One request carrying 5,453 entries -- each with a full serialised payload --
died mid-upload, and because `replace_pending_alerts` was a single call, the
failure took the whole queue with it. The alerts were not held, not sent, and
not recoverable; the next sweep simply re-derived what it could.

`get_history_bulk` already solved this shape with `HISTORY_BULK_CHUNK`. This
does the same: the first chunk goes as `replace` (which clears the table), the
rest as `append` (whose INSERT is ON CONFLICT DO UPDATE, so it is idempotent).

No test in this file touches the network.
"""

from __future__ import annotations

from typing import Any

import pytest

from collectors.run_sweep import PENDING_ALERTS_CHUNK, WorkerClient


class FakeResponse:
    def __init__(self, status: int = 200) -> None:
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict[str, Any]:
        return {"ok": True}


class RecordingSession:
    """Captures every POST body so chunking can be asserted precisely."""

    def __init__(self, fail_on_call: int | None = None) -> None:
        self.posts: list[tuple[str, dict[str, Any]]] = []
        self.fail_on_call = fail_on_call

    def post(self, url: str, json: dict[str, Any] | None = None, **_: Any) -> FakeResponse:
        self.posts.append((url, json or {}))
        if self.fail_on_call is not None and len(self.posts) == self.fail_on_call:
            return FakeResponse(500)
        return FakeResponse(200)


def entries(n: int) -> list[dict[str, Any]]:
    return [
        {
            "id": f"p{i}|threshold|10.0|0",
            "product_id": f"p{i}",
            "kind": "threshold",
            "price": 10.0,
            "scheduled_for": 0,
            "payload": {"message": "x" * 200},
        }
        for i in range(n)
    ]


def client(session: RecordingSession) -> WorkerClient:
    return WorkerClient(base_url="https://w.example", ingest_key="k", session=session)


def test_a_small_queue_is_still_one_replace() -> None:
    """Chunking must not add round trips to the common case."""
    session = RecordingSession()
    client(session).replace_pending_alerts(entries(3))

    assert len(session.posts) == 1
    _url, body = session.posts[0]
    assert body["action"] == "replace"
    assert len(body["alerts"]) == 3


def test_an_empty_queue_still_sends_one_replace_to_clear_it() -> None:
    """The emptying case is load-bearing.

    When every held alert has been delivered, the sweep writes an empty set --
    and that write is what clears `pending_alerts`. Skipping the request as an
    optimisation would leave every delivered alert in the queue to fire again.
    """
    session = RecordingSession()
    client(session).replace_pending_alerts([])

    assert len(session.posts) == 1
    assert session.posts[0][1] == {"action": "replace", "alerts": []}


def test_a_large_queue_is_split_into_replace_then_appends() -> None:
    total = PENDING_ALERTS_CHUNK * 2 + 7
    session = RecordingSession()
    client(session).replace_pending_alerts(entries(total))

    actions = [body["action"] for _url, body in session.posts]
    assert actions == ["replace", "append", "append"], actions

    sizes = [len(body["alerts"]) for _url, body in session.posts]
    assert sizes == [PENDING_ALERTS_CHUNK, PENDING_ALERTS_CHUNK, 7]


def test_exactly_one_chunk_does_not_send_a_trailing_empty_append() -> None:
    session = RecordingSession()
    client(session).replace_pending_alerts(entries(PENDING_ALERTS_CHUNK))

    assert [b["action"] for _u, b in session.posts] == ["replace"]


def test_every_alert_is_sent_exactly_once_across_the_chunks() -> None:
    """Nothing dropped at a boundary, nothing duplicated."""
    total = PENDING_ALERTS_CHUNK * 3 + 1
    session = RecordingSession()
    client(session).replace_pending_alerts(entries(total))

    sent = [a["id"] for _url, body in session.posts for a in body["alerts"]]
    assert len(sent) == total
    assert sorted(sent) == sorted(e["id"] for e in entries(total))


def test_the_first_chunk_is_the_replace_so_the_table_is_cleared_once() -> None:
    """Only the first request may clear the table.

    A second `replace` part-way through would delete the chunks already
    written -- the queue would end up holding only the final chunk.
    """
    session = RecordingSession()
    client(session).replace_pending_alerts(entries(PENDING_ALERTS_CHUNK * 3))

    assert [b["action"] for _u, b in session.posts].count("replace") == 1
    assert session.posts[0][1]["action"] == "replace"


def test_a_failing_chunk_raises_rather_than_reporting_success() -> None:
    """A partial write must not look like a completed one.

    The caller logs `pending_alerts_save_failed` and moves on; what it must
    never do is believe a truncated queue is the whole queue.
    """
    session = RecordingSession(fail_on_call=2)

    with pytest.raises(RuntimeError):
        client(session).replace_pending_alerts(entries(PENDING_ALERTS_CHUNK * 2))
