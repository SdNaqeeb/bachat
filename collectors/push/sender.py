"""FCM HTTP v1 sender.

Sends directly to `https://fcm.googleapis.com/v1/projects/<id>/messages:send`
-- no Expo push relay (spec section 10). `priority: high` plus a per-category
Android notification channel (IMPORTANCE_HIGH is configured on the channel,
mobile-side; this sender just names the channel) so notifications wake a
killed app.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable

from collectors.push.auth import AccessTokenCache
from collectors.push.models import PushMessage, SendOutcome, SendResult, channel_id_for
from collectors.push.transport import Transport

FCM_SEND_URL_TPL = "https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"

# FCM v1 error codes (google.firebase.fcm.v1.FcmErrorCode) that mean "this
# token will never work again" -- no amount of retrying helps.
PERMANENT_ERROR_CODES = {"UNREGISTERED", "INVALID_ARGUMENT", "SENDER_ID_MISMATCH"}
# Everything else (QUOTA_EXCEEDED, UNAVAILABLE, INTERNAL, unknown/absent
# codes) is treated as transient: worth retrying, never a reason to drop
# the device registration.


def build_message_body(message: PushMessage) -> dict:
    return {
        "message": {
            "token": message.token,
            "notification": {"title": message.title, "body": message.body},
            "data": message.data,
            "android": {
                "priority": "high",
                "notification": {"channel_id": channel_id_for(message.category)},
            },
        }
    }


def _classify_error(status_code: int, body: dict) -> SendOutcome:
    error = body.get("error", {})
    for detail in error.get("details", []):
        code = detail.get("errorCode")
        if code in PERMANENT_ERROR_CODES:
            return SendOutcome.PERMANENT_FAILURE
    if status_code in (400, 404):
        # A malformed request or unknown route -- not something a retry
        # will fix, even without a recognised FcmError detail.
        return SendOutcome.PERMANENT_FAILURE
    return SendOutcome.TRANSIENT_FAILURE


@dataclass
class FCMSender:
    project_id: str
    token_cache: AccessTokenCache
    transport: Transport
    max_attempts: int = 3
    backoff_seconds: float = 1.0
    sleep: Callable[[float], None] = field(default=time.sleep)  # injectable to keep tests instant

    def send(self, message: PushMessage) -> SendResult:
        url = FCM_SEND_URL_TPL.format(project_id=self.project_id)
        body = build_message_body(message)

        last_result: SendResult | None = None
        for attempt in range(1, self.max_attempts + 1):
            force_refresh = attempt > 1 and last_result is not None and last_result.status_code == 401
            token = self.token_cache.get(force_refresh=force_refresh)
            resp = self.transport.post(
                url,
                json=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json; UTF-8",
                },
            )

            if resp.status_code == 200:
                return SendResult(outcome=SendOutcome.SENT, status_code=200, detail="ok")

            if resp.status_code == 401:
                # Expired/invalid token: refresh and retry, this never
                # counts as a permanent failure of the token itself.
                last_result = SendResult(
                    outcome=SendOutcome.TRANSIENT_FAILURE,
                    status_code=401,
                    detail="access token rejected, refreshing",
                )
                continue

            outcome = _classify_error(resp.status_code, resp.body)
            last_result = SendResult(
                outcome=outcome,
                status_code=resp.status_code,
                detail=str(resp.body or resp.text),
            )

            if outcome == SendOutcome.PERMANENT_FAILURE:
                return last_result

            if attempt < self.max_attempts:
                self.sleep(self.backoff_seconds * (2 ** (attempt - 1)))

        assert last_result is not None
        return last_result
