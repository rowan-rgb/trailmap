"""Local cache for Strava run records (GPS streams + segment efforts)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from strava_routes import (
    build_timeline_payload,
    fetch_single_run_by_id,
    list_runs_in_range,
)

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / ".data" / "strava_runs"
INDEX_PATH = CACHE_DIR / "index.json"
SYNC_STATE_PATH = CACHE_DIR / "sync_state.json"

DEFAULT_SYNC_START = "2025-01-01"
DEFAULT_SYNC_END = "2026-12-31"


def _run_path(activity_id: int) -> Path:
    return CACHE_DIR / f"{activity_id}.json"


def _parse_run_date(value: str | None) -> str | None:
    if not value:
        return None
    return value[:10]


def _run_in_range(run: dict[str, Any], start_date: str, end_date: str) -> bool:
    run_date = _parse_run_date(run.get("start_date"))
    if not run_date:
        return False
    return start_date <= run_date <= end_date


def load_index() -> dict[str, Any]:
    if not INDEX_PATH.exists():
        return {"runs": [], "last_sync_at": None}
    return json.loads(INDEX_PATH.read_text(encoding="utf-8"))


def save_index(index: dict[str, Any]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps(index, indent=2), encoding="utf-8")


def load_sync_state() -> dict[str, Any]:
    if not SYNC_STATE_PATH.exists():
        return {}
    return json.loads(SYNC_STATE_PATH.read_text(encoding="utf-8"))


def save_sync_state(state: dict[str, Any]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if not state:
        if SYNC_STATE_PATH.exists():
            SYNC_STATE_PATH.unlink()
        return
    SYNC_STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def load_run(activity_id: int) -> dict[str, Any] | None:
    path = _run_path(activity_id)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_run(run: dict[str, Any]) -> None:
    activity_id = int(run["id"])
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _run_path(activity_id).write_text(json.dumps(run, indent=2), encoding="utf-8")

    index = load_index()
    entries = [item for item in index.get("runs", []) if int(item["id"]) != activity_id]
    entries.append(
        {
            "id": activity_id,
            "name": run.get("name"),
            "type": run.get("type"),
            "start_date": run.get("start_date"),
            "distance_km": run.get("distance_km"),
            "elevation_gain_m": run.get("elevation_gain_m"),
        }
    )
    entries.sort(key=lambda item: item.get("start_date") or "")
    index["runs"] = entries
    save_index(index)


def get_status() -> dict[str, Any]:
    index = load_index()
    sync_state = load_sync_state()
    dates = [_parse_run_date(item.get("start_date")) for item in index.get("runs", [])]
    dates = [value for value in dates if value]
    pending_ids = sync_state.get("pending_ids") or []
    sync_range = sync_state.get("sync_range") or {}

    return {
        "run_count": len(index.get("runs", [])),
        "min_date": min(dates) if dates else None,
        "max_date": max(dates) if dates else None,
        "last_sync_at": index.get("last_sync_at"),
        "sync_in_progress": bool(pending_ids),
        "pending_count": len(pending_ids),
        "sync_range": sync_range,
        "default_sync_start": DEFAULT_SYNC_START,
        "default_sync_end": DEFAULT_SYNC_END,
    }


def load_runs_for_range(start_date: str, end_date: str) -> list[dict[str, Any]]:
    index = load_index()
    runs: list[dict[str, Any]] = []

    for entry in index.get("runs", []):
        run_date = _parse_run_date(entry.get("start_date"))
        if not run_date or not (start_date <= run_date <= end_date):
            continue
        run = load_run(int(entry["id"]))
        if run:
            runs.append(run)

    runs.sort(key=lambda item: item.get("start_date") or "")
    return runs


def timeline_from_cache(start_date: str, end_date: str) -> dict[str, Any]:
    runs = load_runs_for_range(start_date, end_date)
    return build_timeline_payload(
        runs,
        start_date=start_date,
        end_date=end_date,
        source="cache",
    )


def segments_from_cache(segment_ids: list[int]) -> dict[str, Any]:
    """Build segment map paths from cached run segment_efforts."""
    wanted = {int(item) for item in segment_ids if item}
    if not wanted:
        return {"segments": []}

    by_id: dict[int, dict[str, Any]] = {}
    for entry in load_index().get("runs", []):
        run = load_run(int(entry["id"]))
        if not run:
            continue
        for effort in run.get("segment_efforts") or []:
            segment_id = int(effort.get("segment_id") or 0)
            if not segment_id or segment_id not in wanted or segment_id in by_id:
                continue
            path = effort.get("path") or []
            if len(path) < 2:
                continue
            by_id[segment_id] = {
                "id": segment_id,
                "name": effort.get("segment_name") or "Segment",
                "distance_km": (
                    round((effort.get("distance_m") or 0) / 1000, 2)
                    if effort.get("distance_m")
                    else None
                ),
                "path": path,
            }

    return {"segments": list(by_id.values())}


def prepare_sync(
    access_token: str,
    *,
    start_date: str = DEFAULT_SYNC_START,
    end_date: str = DEFAULT_SYNC_END,
) -> dict[str, Any]:
    after_epoch = int(
        datetime.strptime(start_date, "%Y-%m-%d")
        .replace(tzinfo=timezone.utc)
        .timestamp()
    )
    before_epoch = int(
        datetime.strptime(end_date, "%Y-%m-%d")
        .replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
        .timestamp()
    )

    activities = list_runs_in_range(
        access_token,
        after_epoch=after_epoch,
        before_epoch=before_epoch,
    )
    cached_ids = {int(item["id"]) for item in load_index().get("runs", [])}
    pending_ids = [int(activity["id"]) for activity in activities if int(activity["id"]) not in cached_ids]

    save_sync_state(
        {
            "sync_range": {"start": start_date, "end": end_date},
            "pending_ids": pending_ids,
            "total_to_fetch": len(pending_ids),
            "fetched": 0,
            "failed": [],
        }
    )

    return {
        "pending_count": len(pending_ids),
        "already_cached": len(cached_ids),
        "listed_on_strava": len(activities),
        "run_count": len(cached_ids),
        "sync_range": {"start": start_date, "end": end_date},
        "complete": not pending_ids,
        "message": "Up to date." if not pending_ids else f"{len(pending_ids)} new run(s) to download.",
    }


def sync_batch(
    access_token: str,
    *,
    batch_size: int = 5,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    sync_state = load_sync_state()
    pending_ids = list(sync_state.get("pending_ids") or [])

    if not pending_ids:
        if start_date and end_date:
            prepare_sync(access_token, start_date=start_date, end_date=end_date)
            sync_state = load_sync_state()
            pending_ids = list(sync_state.get("pending_ids") or [])
        elif not load_index().get("runs"):
            prepare_sync(
                access_token,
                start_date=DEFAULT_SYNC_START,
                end_date=DEFAULT_SYNC_END,
            )
            sync_state = load_sync_state()
            pending_ids = list(sync_state.get("pending_ids") or [])

    if not pending_ids:
        index = load_index()
        index["last_sync_at"] = datetime.now(timezone.utc).isoformat()
        save_index(index)
        save_sync_state({})
        status = get_status()
        return {
            "complete": True,
            "synced_this_batch": 0,
            "failed_this_batch": [],
            "pending_count": 0,
            "run_count": status["run_count"],
            "message": "Local cache is up to date.",
        }

    batch_size = max(1, min(batch_size, 10))
    batch_ids = pending_ids[:batch_size]
    synced: list[int] = []
    failed: list[dict[str, Any]] = []
    index = load_index()
    color_offset = len(index.get("runs", []))

    for offset, activity_id in enumerate(batch_ids):
        try:
            run = fetch_single_run_by_id(
                access_token,
                activity_id,
                color_index=color_offset + offset,
            )
            if not run:
                failed.append({"id": activity_id, "reason": "missing GPS stream"})
                continue
            save_run(run)
            synced.append(activity_id)
        except Exception as exc:  # noqa: BLE001 - keep syncing after individual failures
            failed.append({"id": activity_id, "reason": str(exc)})

    retry_ids = {
        int(item["id"])
        for item in failed
        if "429" in str(item.get("reason", ""))
    }
    drop_ids = {int(item["id"]) for item in failed} - retry_ids
    remaining = [
        activity_id
        for activity_id in pending_ids
        if activity_id not in synced and activity_id not in drop_ids
    ]
    sync_state["pending_ids"] = remaining
    sync_state["fetched"] = int(sync_state.get("fetched") or 0) + len(synced)
    sync_state.setdefault("failed", []).extend(failed)
    save_sync_state(sync_state if remaining else {})

    if not remaining:
        index = load_index()
        index["last_sync_at"] = datetime.now(timezone.utc).isoformat()
        save_index(index)

    status = get_status()
    return {
        "complete": not remaining,
        "synced_this_batch": len(synced),
        "failed_this_batch": failed,
        "pending_count": len(remaining),
        "run_count": status["run_count"],
        "sync_range": sync_state.get("sync_range") or status.get("sync_range") or {},
        "message": (
            f"Synced {len(synced)} run(s)."
            if synced
            else ("Finished." if not remaining else "Waiting for next batch.")
        ),
    }
