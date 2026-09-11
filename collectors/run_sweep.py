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
    FCM_DEVICE_TOKEN          the (single) phone's current FCM registration
                               token. NOTE: worker/schema.sql has a `devices`
                               table and a POST /api/register-device route,
                               which is the real source of truth for this --
                               but no GET route exists yet to read it back,
                               so this entrypoint uses a static secret for
                               v1. Flagged in the delivered report.

--- Worker API contract this entrypoint depends on ---------------------

Verified directly against worker/src/routes/*.ts and worker/src/lib/*.ts:

    GET  /api/prefs
        -> { "prefs": { "threshold_pct": 0.6,
                         "quiet_hours": {"start":"23:00","end":"08:00","tz":"Asia/Kolkata"},
                         "location": {"lat":..,"lon":..,"pincode":..},
                         "enabled_categories": ["dairy", "fashion-tops", ...],
                         ... any other keys, including ones this file owns
                         ("pending_alerts", "sent_alerts_log") ... } }

    POST /api/prefs
        body: a flat map of key -> value to upsert; any subset of keys.
        Used both for real user prefs (not by this file) and, pragmatically,
        as the persistence layer for this file's own alert-queue state (see
        below) -- there is no dedicated endpoint for that.

    POST /api/ingest   [header X-Ingest-Key: <INGEST_KEY>]
        body: { "retailer_id": "blinkit", "captured_at": <epoch MILLIS>,
                "offers": [ {ext_id, name, price, mrp, in_stock, url,
                             category, mode, brand, size, image_url}, ... ] }
        -> { "ok": true, "products_upserted": N, "price_rows_attempted": N,
             "rollups_upserted": N }
        Product ids are NOT returned -- they are deterministic:
        f"{retailer_id}:{offer.ext_id}" (see worker/src/lib/ingest.ts).

    GET /api/history/:productId?days=30
        -> { "product_id", "days_requested", "days_observed", "series":
             [{"day","min_price","max_price"}, ...] (oldest first, INCLUDES
             today's row since ingest already wrote it), "current_price",
             "current_captured_at", "period_low": {...} }
        This entrypoint uses only `series`, dropping the last (today's) row
        to get "prior days" history in the shape collectors.engine expects
        (ProductSnapshot.trailing_daily_mins excludes today). The worker's
        own `period_low` field is for the mobile app's UI and is not used
        here -- the deal engine (collectors/engine) makes its own honest
        decision from the same raw `series` data.

--- Known gap: no /api/alerts route ------------------------------------

worker/schema.sql defines an `alerts` table (the intended dedupe log and,
presumably, the mobile app's alert-history view) but no route exposes it
yet. Rather than block on that, this entrypoint persists its OWN dedupe
log and held-alert queue inside the generic `prefs` KV surface, under the
keys "sent_alerts_log" and "pending_alerts". This works, but it means the
real `alerts` table stays empty and any future "alert history" UI reading
directly from it will see nothing. Recommend the worker add a proper
POST/GET /api/alerts pair backed by that table; swapping this file over is
a small, isolated change (see WorkerClient).
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

# How many entries of the dedupe log to keep in the prefs blob. Generous
# relative to "a handful of alerts per day" (spec section 2) so nothing
# ages out before its 90-day price history does.
SENT_LOG_MAX_ENTRIES = 2000


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

    def set_prefs(self, values: dict[str, Any]) -> None:
        resp = self._session.post(f"{self.base_url}/api/prefs", json=values, timeout=self.timeout)
        resp.raise_for_status()

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

    def get_history(self, product_id: str, days: int = 30) -> dict[str, Any]:
        resp = self._session.get(
            f"{self.base_url}/api/history/{product_id}",
            params={"days": days},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()


def product_id_for(retailer_id: str, ext_id: str) -> str:
    """Mirrors worker/src/lib/ingest.ts's deterministic product id."""
    return f"{retailer_id}:{ext_id}"


def trailing_daily_mins_from_history(history: dict[str, Any]) -> tuple[float, ...]:
    """The engine wants PRIOR-day minimums, oldest first, excluding today.

    The history endpoint's `series` already includes today's row (ingest
    ran first), so today is always the last entry when present -- drop it.
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


def categories_for_mode(enabled_categories: frozenset[str], mode: str) -> list[Any]:
    """Which of the user's enabled categories apply to this sweep's mode.

    ASSUMPTION (flagged as ambiguous in the design spec): categories are
    not explicitly tagged with a mode in `prefs.enabled_categories` -- it
    is a flat list of slugs (see worker/schema.sql seed data, e.g.
    "dairy", "fashion-tops"). This entrypoint uses the "fashion-" prefix
    convention from that seed data as the mode signal. If the real prefs
    shape carries an explicit mode per category, replace this heuristic.
    """
    selected = [c for c in sorted(enabled_categories) if (c.startswith("fashion-")) == (mode == "fashion")]
    if Category is None:
        return selected
    return [Category(id=c, slug=c, label=c, mode=mode) for c in selected]


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
# Alert queue persistence (prefs KV, see module docstring's "known gap")
# ---------------------------------------------------------------------------


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


def load_already_sent(raw_prefs: dict[str, Any]) -> set[tuple[str, str, float]]:
    log_entries = raw_prefs.get("sent_alerts_log") or []
    return {(e["product_id"], e["kind"], float(e["price"])) for e in log_entries}


def load_pending(raw_prefs: dict[str, Any]) -> list[Alert]:
    return [alert_from_dict(d) for d in (raw_prefs.get("pending_alerts") or [])]


def build_push_message(alert: Alert, device_token: str) -> PushMessage:
    return PushMessage(
        token=device_token,
        title="Bachat",
        body=alert.message,
        category=alert.category,
        data={"product_id": alert.product_id, "kind": alert.kind, "price": str(alert.price)},
    )


def deliver_alerts(
    ready: list[Alert],
    sender: FCMSender | None,
    device_token: str | None,
    now: datetime,
    dry_run: bool,
) -> tuple[int, list[dict[str, Any]]]:
    """Push every ready alert. Returns (sent_count, newly_sent_log_entries)
    -- the caller persists the log entries into `sent_alerts_log`.
    """
    sent = 0
    new_log_entries: list[dict[str, Any]] = []
    for alert in ready:
        if dry_run or sender is None or not device_token:
            log("alert_dry_run", product_id=alert.product_id, kind=alert.kind, message=alert.message)
            sent += 1
            new_log_entries.append(
                {"product_id": alert.product_id, "kind": alert.kind, "price": alert.price, "sent_at": int(now.timestamp())}
            )
            continue

        result = sender.send(build_push_message(alert, device_token))
        if result.outcome == SendOutcome.SENT:
            sent += 1
            new_log_entries.append(
                {"product_id": alert.product_id, "kind": alert.kind, "price": alert.price, "sent_at": int(now.timestamp())}
            )
        elif result.outcome == SendOutcome.PERMANENT_FAILURE:
            log("push_permanent_failure", level=logging.ERROR, product_id=alert.product_id, detail=result.detail)
        else:
            log("push_transient_failure", level=logging.WARNING, product_id=alert.product_id, detail=result.detail)
    return sent, new_log_entries


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run(mode: str, dry_run: bool = False, now: datetime | None = None) -> list[RetailerRunResult]:
    now = now or datetime.now(timezone.utc)
    captured_at_ms = int(now.timestamp() * 1000)

    worker = WorkerClient(base_url=os.environ["WORKER_BASE_URL"], ingest_key=os.environ.get("INGEST_KEY", ""))
    raw_prefs = worker.get_prefs()
    prefs = build_user_prefs(raw_prefs, mode)
    location = build_location(raw_prefs)
    categories = categories_for_mode(prefs.enabled_categories, mode)

    sender: FCMSender | None = None
    device_token = os.environ.get("FCM_DEVICE_TOKEN")
    sa_json = os.environ.get("FCM_SERVICE_ACCOUNT_JSON")
    if sa_json and not dry_run:
        sa = ServiceAccount.from_json(sa_json)
        transport = RequestsTransport()
        sender = FCMSender(project_id=sa.project_id, token_cache=AccessTokenCache(sa, transport), transport=transport)

    results: list[RetailerRunResult] = []
    all_snapshots: list[ProductSnapshot] = []

    for retailer_id, adapter in ADAPTERS.items():
        if getattr(adapter, "mode", None) != mode:
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

            # Only fetch history (and thus only evaluate) for offers the
            # engine could possibly alert on -- everything else was still
            # ingested (so its price history keeps growing) but skipping
            # the history round-trip here keeps the sweep inside budget.
            evaluable = [o for o in offers if o.in_stock and o.category in prefs.enabled_categories]
            for offer in evaluable:
                product_id = product_id_for(retailer_id, offer.ext_id)
                try:
                    history = worker.get_history(product_id, days=30)
                except Exception as exc:  # noqa: BLE001 - one product's history miss must not abort the retailer
                    log("history_fetch_failed", level=logging.WARNING, product_id=product_id, error=str(exc))
                    continue
                all_snapshots.append(build_snapshot(offer, retailer_id, mode, history, now))

        results.append(result)

    # --- Engine: pure decision over everything collected this run --------
    already_sent = load_already_sent(raw_prefs)
    new_alerts = evaluate_batch(all_snapshots, prefs, already_sent)
    pending = load_pending(raw_prefs)

    combined = pending + new_alerts
    ready = [a for a in combined if a.scheduled_for <= now]
    still_held = [a for a in combined if a.scheduled_for > now]

    sent_count, new_log_entries = deliver_alerts(ready, sender, device_token, now, dry_run)

    try:
        sent_log = (raw_prefs.get("sent_alerts_log") or []) + new_log_entries
        sent_log = sent_log[-SENT_LOG_MAX_ENTRIES:]
        worker.set_prefs(
            {
                "pending_alerts": [alert_to_dict(a) for a in still_held],
                "sent_alerts_log": sent_log,
            }
        )
    except Exception as exc:  # noqa: BLE001 - never abort the run over bookkeeping persistence
        log("alert_state_save_failed", level=logging.WARNING, error=str(exc))

    alerts_by_retailer: dict[str, int] = {}
    for alert in ready:
        alerts_by_retailer[alert.retailer_id] = alerts_by_retailer.get(alert.retailer_id, 0) + 1
    for result in results:
        result.alerts_fired = alerts_by_retailer.get(result.retailer_id, 0)

    print_summary(mode, results, sent_count, len(still_held))
    return results


def print_summary(mode: str, results: list[RetailerRunResult], alerts_sent: int, alerts_held: int) -> None:
    log(
        "sweep_summary",
        mode=mode,
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
    print(f"  -- {alerts_sent} alert(s) sent, {alerts_held} held for quiet hours --\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a Bachat collector sweep")
    parser.add_argument("--mode", choices=["quick", "fashion"], required=True)
    parser.add_argument("--dry-run", action="store_true", help="Collect and evaluate, but never push or record sends")
    args = parser.parse_args(argv)

    configure_logging()
    started = time.monotonic()
    try:
        results = run(args.mode, dry_run=args.dry_run)
    except Exception:
        logger.exception("sweep_fatal_error")
        return 1
    log("sweep_done", mode=args.mode, seconds=round(time.monotonic() - started, 1))
    # Exit non-zero only if EVERY retailer failed outright -- a partial
    # run (some retailers ok, one blocked) is a successful CI run by
    # design (spec section 6: one retailer failing must never abort it).
    if results and all(r.error for r in results):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
