#!/usr/bin/env python3
"""The sweep job entrypoint: adapters -> ingest -> engine -> push.

This is the one place in ``collectors/`` that is allowed to do I/O against
the network, the Worker API, and FCM. Everything it calls into
(``collectors.engine``, the adapters) is pure or fails soft, so all the
retrying, logging, and "don't let one retailer ruin the run" logic lives
here.

Usage:
    python -m collectors.run_sweep --mode quick
    python -m collectors.run_sweep --mode fashion --dry-run

Required environment variables (populated from GitHub Actions secrets in
CI, see .github/workflows/):

    WORKER_BASE_URL           e.g. https://bachat-worker.<acct>.workers.dev
    INGEST_KEY                shared secret required on X-Ingest-Key (matches
                               the Worker's `wrangler secret put INGEST_KEY`)
    FCM_SERVICE_ACCOUNT_JSON  the full service-account key JSON, as a string
    FCM_DEVICE_TOKEN          OPTIONAL fallback only. The real source of
                               truth is the device the app registered via
                               POST /api/register-device, read back here with
                               GET /api/register-device. This env var is used
                               only when no device is registered yet.

--- Worker API contract this entrypoint depends on ---------------------

Verified directly against worker/src/routes/*.ts and worker/src/lib/*.ts:

    GET  /api/prefs
        -> { "prefs": { "threshold_pct": 0.6,
                         "quiet_hours": {"start":"23:00","end":"08:00","tz":"Asia/Kolkata"},
                         "location": {"lat":..,"lon":..,"pincode":..},
                         "enabled_categories": ["dairy", "fashion-tops", ...],
                         ... } }
        NOTE: `prefs` holds USER settings only. This file no longer stores
        any of its own state here -- see /api/alerts below.

    GET /api/categories[?mode=quick]
        -> { "categories": [ {"slug": "dairy", "label": "Dairy",
                               "mode": "quick"}, ... ] }
        The category catalog. `mode` is a stored column, which is what lets
        this file map an enabled category slug to quick-vs-fashion as DATA
        instead of guessing from a "fashion-" name prefix.

    POST /api/ingest   [header X-Ingest-Key: <INGEST_KEY>]
        body: { "retailer_id": "blinkit", "captured_at": <epoch MILLIS>,
                "offers": [ {ext_id, name, price, mrp, in_stock, url,
                             category, mode, brand, size, image_url}, ... ] }
        -> { "ok": true, "products_upserted": N, "price_rows_attempted": N,
             "rollups_upserted": N }
        Product ids are NOT returned -- they are deterministic:
        f"{retailer_id}:{offer.ext_id}" (see worker/src/lib/ingest.ts).

    POST /api/history/bulk
        body: { "product_ids": [...], "days": 30 }
        -> { "days_requested", "requested", "missing": [...],
             "items": [ { "product_id", "days_observed", "series":
                          [{"day","min_price","max_price"}, ...] (oldest
                          first, INCLUDES today's row since ingest already
                          wrote it), "current_price", "current_captured_at",
                          "period_low": {...} }, ... ] }
        ONE round trip for up to 500 products instead of one GET per
        product -- at ~400 products per retailer that per-product loop was
        the single biggest threat to the ~6 minute sweep budget (spec 12).
        `days_observed` is the REAL row count for each product; the worker
        never defaults it, and neither does this file.
        The per-product GET /api/history/:productId still exists (the app
        uses it for the sparkline) and returns the same numbers.

    GET  /api/register-device  [header X-Ingest-Key]
        -> { "device": {"token", "platform", "registered_at"} | null }
        `null` is a NORMAL answer: a fresh install has not registered yet.
        The sweep still runs and still ingests prices; it just cannot push.

    GET  /api/alerts?since=<epoch ms>&product_id=&kind=&limit=
        -> { "alerts": [ {"id","product_id","kind","price","sent_at"} ],
             "count", "since" }
        The dedupe log, read from the real `alerts` table. The engine
        dedupes on the (product_id, kind, price) tuple.

    POST /api/alerts  [header X-Ingest-Key]
        body: { "alerts": [ {product_id, kind, price, sent_at}, ... ] }
        Records what was actually delivered. Idempotent: a retried POST
        with the same values does not duplicate the log entry.

    GET  /api/alerts/pending[?due_by=<epoch ms>]
        -> { "pending": [ {"id","product_id","kind","price",
                            "scheduled_for","created_at","payload"} ],
             "count" }
    POST /api/alerts/pending  [header X-Ingest-Key]
        body: { "action": "replace", "alerts": [ {product_id, kind, price,
                 scheduled_for (epoch ms), payload: <full engine Alert>} ] }
        The quiet-hours hold queue. Spec 7: quiet-hours alerts are HELD and
        delivered in the morning, never dropped -- and since every sweep is
        a fresh GitHub Actions process, that queue has to be durable
        server-side. `payload` round-trips the whole engine Alert so the
        morning delivery sends the real message, not a reconstruction.

"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

from collectors.engine import (
    MAX_HISTORY_WINDOW_DAYS,
    Alert,
    ProductSnapshot,
    QuietHours,
    UserPrefs,
    evaluate_batch,
)
from collectors.push import (
    AccessTokenCache,
    FCMSender,
    PushMessage,
    RequestsTransport,
    SendOutcome,
    ServiceAccount,
)

try:
    from collectors.adapters import ADAPTERS
except Exception:  # pragma: no cover - adapters package still landing
    ADAPTERS: dict[str, Any] = {}

try:
    from collectors.core.types import Category, Location
except Exception:  # pragma: no cover - core package still landing
    Category = None  # type: ignore[assignment,misc]
    Location = None  # type: ignore[assignment,misc]


logger = logging.getLogger("bachat.run_sweep")

# How far back to read the alert dedupe log. 90 days matches the `prices`
# retention window (spec section 5), so a product's dedupe state never
# outlives the history that produced it.
DEDUPE_WINDOW_DAYS = 90

# Product ids per POST /api/history/bulk request.
#
# The worker accepts 500 per request and internally splits them into
# set-based SQL chunks of 90 (D1 caps a prepared statement at 100 bound
# parameters). 200 is chosen here, below that ceiling, so that one HTTP
# request is a small, bounded unit of Worker CPU (spec section 2: 10 ms per
# invocation) while still collapsing a 400-product retailer from 400 round
# trips into 2. Raising it to 500 would work but makes a single slow request
# cost more to retry; lowering it costs round trips, which is the exact
# thing this endpoint exists to remove.
HISTORY_BULK_CHUNK = 200

# Held alerts per POST /api/alerts/pending. Lower than the history chunk
# because each entry carries a full serialised alert payload rather than a bare
# id, and because the worker turns every one into its own D1 statement inside a
# single batch. One unchunked request holding 5,453 alerts died mid-upload with
# an SSL write error and lost the entire queue.
PENDING_ALERTS_CHUNK = 100


# ---------------------------------------------------------------------------
# Structured logging
# ---------------------------------------------------------------------------


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        extra = getattr(record, "extra_fields", None)
        if extra:
            payload.update(extra)
        return json.dumps(payload, default=str)


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonLogFormatter())
    root = logging.getLogger("bachat")
    root.handlers = [handler]
    root.setLevel(level)
    root.propagate = False


def log(event: str, level: int = logging.INFO, **fields: Any) -> None:
    logger.log(level, event, extra={"extra_fields": fields})


# ---------------------------------------------------------------------------
# Worker client (I/O)
# ---------------------------------------------------------------------------


class ConfigError(RuntimeError):
    """A required environment variable is missing or malformed."""


def require_worker_base_url() -> str:
    """Read and validate WORKER_BASE_URL.

    GitHub Actions substitutes an *empty string* for a secret that does not
    exist, so ``os.environ["WORKER_BASE_URL"]`` succeeds and the bad value
    only surfaces much later as a ``requests.MissingSchema`` on the first
    call. Fail here, where the message can name the secret.
    """
    raw = os.environ.get("WORKER_BASE_URL", "").strip()
    if not raw:
        raise ConfigError(
            "WORKER_BASE_URL is empty or unset. In CI it comes from the repo "
            "secret of the same name (Settings -> Secrets and variables -> "
            "Actions); a secret that does not exist arrives as an empty "
            "string rather than an error, so check the spelling of the "
            "secret, not just its presence."
        )
    if not raw.startswith(("http://", "https://")):
        raise ConfigError(
            f"WORKER_BASE_URL must include a scheme; got {raw!r}. "
            f"Did you mean https://{raw}?"
        )
    return raw


class WorkerClient:
    def __init__(self, base_url: str, ingest_key: str, session: Any = None, timeout: float = 15.0):
        self.base_url = base_url.rstrip("/")
        self.ingest_key = ingest_key
        self.timeout = timeout
        if session is None:
            import requests

            session = requests.Session()
        self._session = session

    def get_prefs(self) -> dict[str, Any]:
        resp = self._session.get(f"{self.base_url}/api/prefs", timeout=self.timeout)
        resp.raise_for_status()
        return resp.json().get("prefs", {})

    def ingest(self, retailer_id: str, mode: str, offers: list[Any], captured_at_ms: int) -> dict[str, Any]:
        payload_offers = []
        for o in offers:
            d = asdict(o)
            d["mode"] = mode
            payload_offers.append(d)
        body = {"retailer_id": retailer_id, "captured_at": captured_at_ms, "offers": payload_offers}
        resp = self._session.post(
            f"{self.base_url}/api/ingest",
            json=body,
            headers={"X-Ingest-Key": self.ingest_key},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def get_categories(self) -> list[dict[str, Any]]:
        """The category catalog. Each entry carries its `mode` as data."""
        resp = self._session.get(f"{self.base_url}/api/categories", timeout=self.timeout)
        resp.raise_for_status()
        return resp.json().get("categories", [])

    def get_history_bulk(self, product_ids: list[str], days: int = 30) -> dict[str, dict[str, Any]]:
        """Trailing daily history for many products, keyed by product id.

        Sends ``HISTORY_BULK_CHUNK`` ids per request. Every returned item
        carries the REAL ``days_observed`` for that product; nothing here
        defaults, pads or infers it (spec section 7).
        """
        out: dict[str, dict[str, Any]] = {}
        for i in range(0, len(product_ids), HISTORY_BULK_CHUNK):
            batch = product_ids[i : i + HISTORY_BULK_CHUNK]
            resp = self._session.post(
                f"{self.base_url}/api/history/bulk",
                json={"product_ids": batch, "days": days},
                timeout=self.timeout,
            )
            resp.raise_for_status()
            body = resp.json()
            for item in body.get("items", []):
                out[item["product_id"]] = item
            for missing in body.get("missing", []):
                log("history_bulk_missing_product", level=logging.WARNING, product_id=missing)
        return out

    def get_device_token(self) -> str | None:
        """The FCM token the app registered, or None if no device has yet.

        `None` is a normal state (a fresh install), not an error.
        """
        resp = self._session.get(
            f"{self.base_url}/api/register-device",
            headers={"X-Ingest-Key": self.ingest_key},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        device = resp.json().get("device")
        if not device:
            return None
        token = device.get("token")
        return token or None

    def get_sent_alerts(self, since_ms: int) -> list[dict[str, Any]]:
        resp = self._session.get(
            f"{self.base_url}/api/alerts",
            params={"since": since_ms},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json().get("alerts", [])

    def record_sent_alerts(self, records: list[dict[str, Any]]) -> None:
        if not records:
            return
        resp = self._session.post(
            f"{self.base_url}/api/alerts",
            json={"alerts": records},
            headers={"X-Ingest-Key": self.ingest_key},
            timeout=self.timeout,
        )
        resp.raise_for_status()

    def get_pending_alerts(self) -> list[dict[str, Any]]:
        resp = self._session.get(f"{self.base_url}/api/alerts/pending", timeout=self.timeout)
        resp.raise_for_status()
        return resp.json().get("pending", [])

    def replace_pending_alerts(self, entries: list[dict[str, Any]]) -> None:
        """Write the held-alert queue, ``PENDING_ALERTS_CHUNK`` rows per request.

        A single request is what this used to be, and a real sweep holding
        5,453 alerts died mid-upload with an SSL write error, losing the whole
        queue. Each entry carries a serialised payload, so the body grew to
        megabytes and the worker turned it into 5,454 D1 statements in one
        batch.

        The first chunk goes as ``replace`` because that is what clears the
        table; every later chunk is an ``append``, whose INSERT is
        ``ON CONFLICT DO UPDATE`` and therefore safe to repeat. Only the first
        request may clear -- a second ``replace`` part way through would delete
        the chunks already written.

        An empty list still sends one ``replace``. That request is what empties
        the queue when every held alert has been delivered, so skipping it as
        an optimisation would re-fire everything on the next sweep.
        """
        url = f"{self.base_url}/api/alerts/pending"
        headers = {"X-Ingest-Key": self.ingest_key}

        for i in range(0, max(len(entries), 1), PENDING_ALERTS_CHUNK):
            resp = self._session.post(
                url,
                json={
                    "action": "replace" if i == 0 else "append",
                    "alerts": entries[i : i + PENDING_ALERTS_CHUNK],
                },
                headers=headers,
                timeout=self.timeout,
            )
            # Raise rather than continue: a truncated queue must not be
            # reported to the caller as a completed write.
            resp.raise_for_status()


def product_id_for(retailer_id: str, ext_id: str) -> str:
    """Mirrors worker/src/lib/ingest.ts's deterministic product id."""
    return f"{retailer_id}:{ext_id}"


def trailing_daily_mins_from_history(history: dict[str, Any]) -> tuple[float, ...]:
    """The engine wants PRIOR-day minimums, oldest first, excluding today.

    The history endpoint's `series` already includes today's row (ingest
    ran first), so today is always the last entry when present -- drop it.

    The engine treats ``len(trailing_daily_mins)`` as the true count of
    prior days observed, so this must never pad or truncate: what the
    worker actually stored is what the engine gets. Works identically for
    an item from /api/history/bulk and one from /api/history/:productId --
    both carry the same `series` and the same honest `days_observed`.
    """
    series = history.get("series") or []
    if not series:
        return ()
    return tuple(float(row["min_price"]) for row in series[:-1])


# ---------------------------------------------------------------------------
# Prefs parsing (I/O boundary -> pure engine types)
# ---------------------------------------------------------------------------


def parse_quiet_hours(raw: dict[str, Any] | None) -> QuietHours:
    from datetime import time as dtime

    if not raw:
        return QuietHours()

    def _parse(s: str) -> dtime:
        h, m = s.split(":")
        return dtime(int(h), int(m))

    return QuietHours(start=_parse(raw.get("start", "23:00")), end=_parse(raw.get("end", "08:00")))


def build_user_prefs(raw_prefs: dict[str, Any], mode: str) -> UserPrefs:
    return UserPrefs(
        mode=mode,
        enabled_categories=frozenset(raw_prefs.get("enabled_categories", [])),
        threshold=float(raw_prefs.get("threshold_pct", 0.60)),
        quiet_hours=parse_quiet_hours(raw_prefs.get("quiet_hours")),
    )


def build_location(raw_prefs: dict[str, Any]) -> Any:
    loc = raw_prefs.get("location") or {}
    if Location is None:
        return loc
    return Location(lat=loc.get("lat"), lon=loc.get("lon"), pincode=loc.get("pincode"))


def categories_for_mode(
    enabled_categories: frozenset[str],
    mode: str,
    catalog: list[dict[str, Any]],
) -> list[Any]:
    """Which of the user's enabled categories apply to this sweep's mode.

    A category's mode is DATA: it comes from the worker's `categories`
    table (GET /api/categories), not from the shape of its slug. An earlier
    version of this function inferred it from a "fashion-" name prefix,
    which meant renaming a slug silently changed which sweep collected it.

    A slug the catalog does not know has no mode, so it is skipped and
    logged. Skipping loudly is the honest behaviour: guessing would sweep
    it in the wrong mode, and the wrong mode means the wrong retailers.
    """
    mode_by_slug = {
        str(entry.get("slug")): str(entry.get("mode"))
        for entry in catalog
        if entry.get("slug") and entry.get("mode")
    }
    label_by_slug = {
        str(entry.get("slug")): str(entry.get("label") or entry.get("slug")) for entry in catalog
    }

    selected: list[str] = []
    for slug in sorted(enabled_categories):
        known_mode = mode_by_slug.get(slug)
        if known_mode is None:
            log(
                "category_mode_unknown",
                level=logging.WARNING,
                category=slug,
                detail="not in the /api/categories catalog; skipped rather than guessed",
            )
            continue
        if known_mode == mode:
            selected.append(slug)

    if not selected:
        # Hard stop, not an empty list. With no categories the per-category
        # loop in sweep_retailer() never runs, so every retailer reports
        # products_collected=0 with no error, `if offers:` skips the ingest
        # call entirely, and main() exits 0. The run goes green having
        # written nothing -- which is how `prefs.enabled_categories` being
        # emptied kept the Deals screen blank through days of "successful"
        # sweeps. Collecting nothing is a misconfiguration, so it is raised
        # as one and the Actions run fails visibly.
        raise ConfigError(
            f"no sweepable categories for mode {mode!r}: "
            f"prefs.enabled_categories={sorted(enabled_categories)} matches none of the "
            f"{sum(1 for m in mode_by_slug.values() if m == mode)} {mode!r} categories in "
            "the /api/categories catalog. Enable at least one in the app's Settings "
            "screen, or POST /api/prefs {\"enabled_categories\": [...]}."
        )

    if Category is None:
        return selected
    return [
        Category(id=c, slug=c, label=label_by_slug.get(c, c), mode=mode) for c in selected
    ]


# ---------------------------------------------------------------------------
# Per-retailer sweep, with fail-soft isolation
# ---------------------------------------------------------------------------


@dataclass
class RetailerRunResult:
    retailer_id: str
    products_collected: int = 0
    blocked: bool = False
    error: str | None = None
    alerts_fired: int = 0


def build_adapter(entry: Any) -> Any:
    """Normalise an ``ADAPTERS`` entry to a usable adapter instance.

    The registry stores classes, so importing it costs no HttpClient and no
    per-retailer session for modes this run will skip. The sweep needs
    *instances*: ``SomeAdapter.sweep(category, loc)`` on the class is an
    unbound call that silently binds ``self=category`` and then fails with
    ``missing 1 required positional argument: 'loc'``. An entry that is
    already an instance passes through, so the registry stays free to hold a
    pre-configured adapter.
    """
    return entry() if isinstance(entry, type) else entry


def sweep_retailer(adapter: Any, categories: list[Any], location: Any) -> tuple[list[Any], RetailerRunResult]:
    """Collect offers for one retailer across all its enabled categories.

    Never raises: any adapter exception is caught, logged, and recorded on
    the result. One broken retailer must not cost the others' data (spec
    section 6).
    """
    result = RetailerRunResult(retailer_id=adapter.id)
    offers: list[Any] = []
    for category in categories:
        try:
            category_offers = adapter.sweep(category, location)
            offers.extend(category_offers)
        except Exception as exc:  # noqa: BLE001 - deliberately broad: fail-soft boundary
            result.error = f"{type(exc).__name__}: {exc}"
            blocked_marker = "blocked" in type(exc).__name__.lower() or "blocked" in str(exc).lower()
            result.blocked = result.blocked or blocked_marker
            log(
                "adapter_sweep_failed",
                level=logging.WARNING,
                retailer=adapter.id,
                category=getattr(category, "slug", str(category)),
                error=result.error,
            )
    result.products_collected = len(offers)
    return offers, result


def build_snapshot(
    offer: Any,
    retailer_id: str,
    mode: str,
    history: dict[str, Any],
    captured_at: datetime,
) -> ProductSnapshot:
    return ProductSnapshot(
        product_id=product_id_for(retailer_id, offer.ext_id),
        retailer_id=retailer_id,
        category=offer.category,
        mode=mode,
        name=offer.name,
        price=offer.price,
        mrp=offer.mrp,
        in_stock=offer.in_stock,
        captured_at=captured_at,
        trailing_daily_mins=trailing_daily_mins_from_history(history),
    )


# ---------------------------------------------------------------------------
# Alert state persistence (the real `alerts` table, via /api/alerts)
# ---------------------------------------------------------------------------
#
# Both the dedupe log and the quiet-hours hold queue live server-side, not
# in this process: every sweep is a fresh GitHub Actions run, so anything
# kept in memory is lost between runs, and a held alert that is lost is a
# dropped alert -- which spec section 7 forbids.


def alert_to_dict(alert: Alert) -> dict[str, Any]:
    d = asdict(alert)
    d["captured_at"] = alert.captured_at.isoformat()
    d["scheduled_for"] = alert.scheduled_for.isoformat()
    return d


def alert_from_dict(d: dict[str, Any]) -> Alert:
    d = dict(d)
    d["captured_at"] = datetime.fromisoformat(d["captured_at"])
    d["scheduled_for"] = datetime.fromisoformat(d["scheduled_for"])
    return Alert(**d)


def load_already_sent(sent_rows: list[dict[str, Any]]) -> set[tuple[str, str, float]]:
    """The engine's dedupe set, built from the `alerts` table rows."""
    return {(r["product_id"], r["kind"], float(r["price"])) for r in sent_rows}


def load_pending(pending_rows: list[dict[str, Any]]) -> list[Alert]:
    """Rehydrate held alerts from the queue, skipping any row whose payload
    no longer decodes rather than crashing the whole sweep over one."""
    out: list[Alert] = []
    for row in pending_rows:
        payload = row.get("payload")
        if not isinstance(payload, dict):
            log("pending_alert_unreadable", level=logging.WARNING, id=row.get("id"))
            continue
        try:
            out.append(alert_from_dict(payload))
        except Exception as exc:  # noqa: BLE001 - one bad row must not lose the rest
            log("pending_alert_unreadable", level=logging.WARNING, id=row.get("id"), error=str(exc))
    return out


def pending_entry(alert: Alert) -> dict[str, Any]:
    """One row for POST /api/alerts/pending. `payload` carries the whole
    Alert so the morning delivery sends the real message."""
    return {
        "product_id": alert.product_id,
        "kind": alert.kind,
        "price": alert.price,
        "scheduled_for": int(alert.scheduled_for.timestamp() * 1000),
        "payload": alert_to_dict(alert),
    }


def build_push_message(alert: Alert, device_token: str) -> PushMessage:
    return PushMessage(
        token=device_token,
        title="Bachat",
        body=alert.message,
        category=alert.category,
        data={"product_id": alert.product_id, "kind": alert.kind, "price": str(alert.price)},
    )


def resolve_device_token(worker: WorkerClient) -> tuple[str | None, str]:
    """The token the app registered, else the static Actions secret.

    Returns (token, source). No registered device is a NORMAL state: a
    fresh install has not registered yet, and the sweep must still run and
    ingest prices -- it simply has nobody to push to.
    """
    try:
        token = worker.get_device_token()
    except Exception as exc:  # noqa: BLE001 - never abort a sweep over push plumbing
        log("device_token_fetch_failed", level=logging.WARNING, error=str(exc))
        token = None

    if token:
        return token, "registered_device"

    env_token = os.environ.get("FCM_DEVICE_TOKEN")
    if env_token:
        log("device_token_fallback", detail="no registered device; using FCM_DEVICE_TOKEN")
        return env_token, "env_fallback"

    log("device_token_absent", detail="no device registered and no FCM_DEVICE_TOKEN; alerts cannot be pushed")
    return None, "none"


def deliver_alerts(
    ready: list[Alert],
    sender: FCMSender | None,
    device_token: str | None,
    now: datetime,
    dry_run: bool,
) -> tuple[int, list[dict[str, Any]]]:
    """Push every ready alert. Returns (sent_count, records) -- the caller
    POSTs the records to /api/alerts so the next sweep dedupes against them.
    """
    sent = 0
    records: list[dict[str, Any]] = []
    sent_at_ms = int(now.timestamp() * 1000)
    for alert in ready:
        if dry_run or sender is None or not device_token:
            log("alert_dry_run", product_id=alert.product_id, kind=alert.kind, message=alert.message)
            sent += 1
            records.append(
                {
                    "product_id": alert.product_id,
                    "kind": alert.kind,
                    "price": alert.price,
                    "sent_at": sent_at_ms,
                }
            )
            continue

        result = sender.send(build_push_message(alert, device_token))
        if result.outcome == SendOutcome.SENT:
            sent += 1
            records.append(
                {
                    "product_id": alert.product_id,
                    "kind": alert.kind,
                    "price": alert.price,
                    "sent_at": sent_at_ms,
                }
            )
        elif result.outcome == SendOutcome.PERMANENT_FAILURE:
            log("push_permanent_failure", level=logging.ERROR, product_id=alert.product_id, detail=result.detail)
        else:
            log("push_transient_failure", level=logging.WARNING, product_id=alert.product_id, detail=result.detail)
    return sent, records


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run(mode: str, dry_run: bool = False, now: datetime | None = None) -> list[RetailerRunResult]:
    now = now or datetime.now(timezone.utc)
    captured_at_ms = int(now.timestamp() * 1000)

    worker = WorkerClient(base_url=require_worker_base_url(), ingest_key=os.environ.get("INGEST_KEY", ""))
    raw_prefs = worker.get_prefs()
    prefs = build_user_prefs(raw_prefs, mode)
    location = build_location(raw_prefs)
    categories = categories_for_mode(prefs.enabled_categories, mode, worker.get_categories())

    sender: FCMSender | None = None
    device_token, token_source = resolve_device_token(worker)
    sa_json = os.environ.get("FCM_SERVICE_ACCOUNT_JSON")
    if sa_json and not dry_run:
        sa = ServiceAccount.from_json(sa_json)
        transport = RequestsTransport()
        sender = FCMSender(project_id=sa.project_id, token_cache=AccessTokenCache(sa, transport), transport=transport)

    results: list[RetailerRunResult] = []
    # (offer, retailer_id) for everything the engine could possibly alert on.
    # History is fetched for all of them in ONE bulk call after every
    # retailer has been ingested, not per product inside the loop.
    evaluable: list[tuple[Any, str]] = []

    for retailer_id, entry in ADAPTERS.items():
        if getattr(entry, "mode", None) != mode:
            continue

        try:
            adapter = build_adapter(entry)
        except Exception as exc:  # noqa: BLE001 - a broken ctor is one retailer's problem
            log("adapter_init_failed", level=logging.ERROR, retailer=retailer_id, error=str(exc))
            results.append(
                RetailerRunResult(retailer_id=retailer_id, error=f"{type(exc).__name__}: {exc}")
            )
            continue

        offers, result = sweep_retailer(adapter, categories, location)

        if offers:
            try:
                worker.ingest(retailer_id, mode, offers, captured_at_ms)
            except Exception as exc:  # noqa: BLE001 - ingest failure must not abort the run
                result.error = result.error or f"ingest failed: {type(exc).__name__}: {exc}"
                log("ingest_failed", level=logging.ERROR, retailer=retailer_id, error=str(exc))
                results.append(result)
                continue

            # Only evaluate offers the engine could possibly alert on --
            # everything else was still ingested (so its price history keeps
            # growing), it just does not need its history read back.
            evaluable.extend(
                (o, retailer_id) for o in offers if o.in_stock and o.category in prefs.enabled_categories
            )

        results.append(result)

    # --- History: ONE bulk call, not one call per product ----------------
    product_ids = [product_id_for(retailer_id, o.ext_id) for o, retailer_id in evaluable]
    histories: dict[str, dict[str, Any]] = {}
    if product_ids:
        try:
            histories = worker.get_history_bulk(product_ids, days=MAX_HISTORY_WINDOW_DAYS)
        except Exception as exc:  # noqa: BLE001 - no history means no period-low claim, not a dead sweep
            log("history_bulk_failed", level=logging.ERROR, products=len(product_ids), error=str(exc))
            histories = {}

    all_snapshots: list[ProductSnapshot] = []
    for offer, retailer_id in evaluable:
        product_id = product_id_for(retailer_id, offer.ext_id)
        history = histories.get(product_id)
        if history is None:
            # No history row means no substantiated claim. Skipping is the
            # honest choice: evaluating with an empty series would announce
            # "lowest in 1 day" for a product we merely failed to read.
            log("history_missing", level=logging.WARNING, product_id=product_id)
            continue
        all_snapshots.append(build_snapshot(offer, retailer_id, mode, history, now))

    # --- Engine: pure decision over everything collected this run --------
    try:
        since_ms = captured_at_ms - DEDUPE_WINDOW_DAYS * 86_400_000
        already_sent = load_already_sent(worker.get_sent_alerts(since_ms))
    except Exception as exc:  # noqa: BLE001
        # An empty dedupe set re-notifies things already sent, so this is
        # the noisy direction of failure and is logged as an error.
        log("alerts_log_fetch_failed", level=logging.ERROR, error=str(exc))
        already_sent = set()

    try:
        pending = load_pending(worker.get_pending_alerts())
    except Exception as exc:  # noqa: BLE001
        log("pending_alerts_fetch_failed", level=logging.ERROR, error=str(exc))
        pending = []

    # Already-held alerts count as "already decided": without this, a
    # product that triggers during quiet hours and is still triggering on
    # the next sweep would be queued twice and notify twice in the morning.
    new_alerts = evaluate_batch(all_snapshots, prefs, already_sent | {a.dedupe_key for a in pending})

    combined = pending + new_alerts
    ready = [a for a in combined if a.scheduled_for <= now]
    still_held = [a for a in combined if a.scheduled_for > now]

    sent_count, sent_records = deliver_alerts(ready, sender, device_token, now, dry_run)

    if dry_run:
        log("alert_state_not_persisted", detail="dry run: nothing recorded, nothing dequeued")
    else:
        # Record the sends BEFORE rewriting the queue: if the process dies
        # between the two, the worst case is an alert that stays held one
        # more sweep, never one that is delivered twice or lost.
        try:
            worker.record_sent_alerts(sent_records)
        except Exception as exc:  # noqa: BLE001 - never abort the run over bookkeeping
            log("alerts_record_failed", level=logging.ERROR, error=str(exc))
        try:
            worker.replace_pending_alerts([pending_entry(a) for a in still_held])
        except Exception as exc:  # noqa: BLE001 - the queue is durable; the next sweep retries
            log("pending_alerts_save_failed", level=logging.ERROR, error=str(exc))

    alerts_by_retailer: dict[str, int] = {}
    for alert in ready:
        alerts_by_retailer[alert.retailer_id] = alerts_by_retailer.get(alert.retailer_id, 0) + 1
    for result in results:
        result.alerts_fired = alerts_by_retailer.get(result.retailer_id, 0)

    print_summary(mode, results, sent_count, len(still_held), token_source)
    return results


def print_summary(
    mode: str,
    results: list[RetailerRunResult],
    alerts_sent: int,
    alerts_held: int,
    token_source: str = "unknown",
) -> None:
    log(
        "sweep_summary",
        mode=mode,
        push_token_source=token_source,
        retailers=[
            {
                "retailer": r.retailer_id,
                "products_collected": r.products_collected,
                "blocked": r.blocked,
                "error": r.error,
                "alerts_fired": r.alerts_fired,
            }
            for r in results
        ],
        alerts_sent=alerts_sent,
        alerts_held_for_quiet_hours=alerts_held,
    )
    print(f"\n=== Bachat sweep summary ({mode}) ===")
    for r in results:
        status = "BLOCKED" if r.blocked else ("ERROR" if r.error else "ok")
        print(
            f"  {r.retailer_id:<12} products={r.products_collected:<5} "
            f"status={status:<8} alerts={r.alerts_fired}" + (f"  ({r.error})" if r.error else "")
        )
    print(
        f"  -- {alerts_sent} alert(s) sent, {alerts_held} held for quiet hours "
        f"(push token: {token_source}) --\n"
    )


def sweep_outcome_exit_code(results: list[RetailerRunResult]) -> int:
    """The run's exit code, given what every retailer actually collected.

    Spec section 6 says one retailer failing must never abort the run, and
    that stays true: a partial sweep (some retailers ok, one blocked) is a
    successful CI run.

    What it does NOT mean is that a sweep which collected *nothing at all*
    is a success. Every layer below here fails soft -- BaseAdapter.sweep()
    swallows the exception and returns `[]`, sweep_retailer() records no
    error for a category loop that never ran, run() skips the ingest call
    on an empty offer list -- so a run that wrote zero rows to D1 looked
    exactly like a healthy one and exited 0. That is how the collector
    reported success 6x/day while the Deals screen stayed empty.

    So the rule is about the outcome, not the errors: if not one retailer
    came back with a single product, the sweep failed.
    """
    if not results:
        return 1
    if all(r.error for r in results):
        return 1
    if not any(r.products_collected > 0 for r in results):
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a Bachat collector sweep")
    parser.add_argument("--mode", choices=["quick", "fashion"], required=True)
    parser.add_argument("--dry-run", action="store_true", help="Collect and evaluate, but never push or record sends")
    args = parser.parse_args(argv)

    configure_logging()
    started = time.monotonic()
    try:
        results = run(args.mode, dry_run=args.dry_run)
    except ConfigError as exc:
        # Misconfiguration, not a sweep failure: no traceback, just the fix.
        log("sweep_misconfigured", level=logging.ERROR, error=str(exc))
        print(f"\nBachat sweep not started: {exc}\n", file=sys.stderr)
        return 2
    except Exception:
        logger.exception("sweep_fatal_error")
        return 1
    log("sweep_done", mode=args.mode, seconds=round(time.monotonic() - started, 1))
    return sweep_outcome_exit_code(results)


if __name__ == "__main__":
    raise SystemExit(main())
