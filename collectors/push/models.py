"""Data types for the FCM push sender."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class SendOutcome(str, Enum):
    """The three outcomes a caller (run_sweep.py) needs to distinguish.

    - SENT: FCM accepted the message.
    - PERMANENT_FAILURE: this token will never work again (unregistered,
      invalid, sender mismatch) -- the caller should stop sending to it and
      remove the device registration; retrying is pointless.
    - TRANSIENT_FAILURE: a retryable condition (rate limit, 5xx, network
      error, an expired access token that has already been retried once) --
      the caller may retry later, but a retry loop must not block the run.
    """

    SENT = "sent"
    PERMANENT_FAILURE = "permanent_failure"
    TRANSIENT_FAILURE = "transient_failure"


@dataclass(frozen=True)
class PushMessage:
    token: str
    title: str
    body: str
    category: str  # -> becomes the Android notification channel id
    data: dict[str, str]


@dataclass(frozen=True)
class SendResult:
    outcome: SendOutcome
    status_code: int | None
    detail: str


def channel_id_for(category: str) -> str:
    """One Android notification channel per category, so the user can mute
    a whole category (e.g. fashion) at the OS level without touching app
    settings. Channel ids must be stable and filesystem/JSON-safe.
    """
    safe = "".join(c if c.isalnum() else "_" for c in category.lower())
    return f"deals_{safe}"
