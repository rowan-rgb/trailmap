#!/usr/bin/env python3
"""Download Strava runs into .data/strava_runs/ for the trail analysis tool.

Prerequisites:
  1. Copy .env.example to .env and add Strava credentials.
  2. Connect Strava once via the map UI (http://localhost:5000/maps → trail analysis).

Usage:
  python download_strava_runs.py
  python download_strava_runs.py --start 2025-01-01 --end 2026-12-31
  python download_strava_runs.py --delay 2.0
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

from strava_cache import (  # noqa: E402
    CACHE_DIR,
    DEFAULT_SYNC_END,
    DEFAULT_SYNC_START,
    load_index,
    save_index,
    save_run,
)
from strava_client import (  # noqa: E402
    DEFAULT_RATE_LIMIT_WAIT_S,
    get_valid_access_token,
    rate_limit_summary,
)
from strava_routes import fetch_single_run_by_id, list_runs_in_range  # noqa: E402


def _date_epochs(start_date: str, end_date: str) -> tuple[int, int]:
    after = int(
        datetime.strptime(start_date, "%Y-%m-%d")
        .replace(tzinfo=timezone.utc)
        .timestamp()
    )
    before = int(
        datetime.strptime(end_date, "%Y-%m-%d")
        .replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
        .timestamp()
    )
    if after >= before:
        raise ValueError("start date must be before end date")
    return after, before


def download_runs(
    access_token: str,
    *,
    start_date: str = DEFAULT_SYNC_START,
    end_date: str = DEFAULT_SYNC_END,
    delay_s: float = 1.5,
    rate_limit_wait_s: int = DEFAULT_RATE_LIMIT_WAIT_S,
) -> dict[str, int | list]:
    after_epoch, before_epoch = _date_epochs(start_date, end_date)

    def on_rate_limit(wait_s: int, response: requests.Response) -> None:
        summary = rate_limit_summary(response)
        wait_min = max(1, round(wait_s / 60))
        suffix = f" · {summary}" if summary else ""
        print(f"\nStrava rate limit — waiting {wait_min} min ({wait_s}s){suffix}…")

    print(f"Listing runs on Strava ({start_date} → {end_date})…")
    print("(If rate limited, the script will wait automatically — do not interrupt.)\n")
    activities = list_runs_in_range(
        access_token,
        after_epoch=after_epoch,
        before_epoch=before_epoch,
        rate_limit_wait_s=rate_limit_wait_s,
        on_rate_limit=on_rate_limit,
    )
    cached_ids = {int(item["id"]) for item in load_index().get("runs", [])}
    to_fetch = [activity for activity in activities if int(activity["id"]) not in cached_ids]

    print(f"Found {len(activities)} runs on Strava · {len(cached_ids)} already cached · {len(to_fetch)} to download")
    print(f"Saving to {CACHE_DIR}\n")

    saved = 0
    skipped = 0
    failed: list[dict[str, str | int]] = []
    color_index = len(cached_ids)

    for index, activity in enumerate(to_fetch, start=1):
        activity_id = int(activity["id"])
        label = activity.get("name") or str(activity_id)

        while True:
            try:
                run = fetch_single_run_by_id(
                    access_token,
                    activity_id,
                    color_index=color_index,
                )
                if not run:
                    skipped += 1
                    print(f"[{index}/{len(to_fetch)}] skip · {label} (no GPS stream)")
                else:
                    save_run(run)
                    saved += 1
                    color_index += 1
                    print(
                        f"[{index}/{len(to_fetch)}] saved · {label} · "
                        f"{run['distance_km']} km · +{run.get('elevation_gain_m', 0)} m"
                    )
                break
            except requests.HTTPError as exc:
                failed.append({"id": activity_id, "name": label, "reason": str(exc)})
                print(f"[{index}/{len(to_fetch)}] failed · {label} · {exc}")
                break
            except Exception as exc:  # noqa: BLE001
                failed.append({"id": activity_id, "name": label, "reason": str(exc)})
                print(f"[{index}/{len(to_fetch)}] failed · {label} · {exc}")
                break

        if index < len(to_fetch):
            time.sleep(delay_s)

    index = load_index()
    index["last_sync_at"] = datetime.now(timezone.utc).isoformat()
    save_index(index)

    sync_state_path = CACHE_DIR / "sync_state.json"
    if sync_state_path.exists():
        sync_state_path.unlink()

    total_cached = len(index.get("runs", []))
    print(
        f"\nDone · saved {saved} · skipped {skipped} · failed {len(failed)} · "
        f"{total_cached} runs in local store"
    )
    return {
        "saved": saved,
        "skipped": skipped,
        "failed": failed,
        "total_cached": total_cached,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Strava runs into the local trail cache.")
    parser.add_argument("--start", default=DEFAULT_SYNC_START, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", default=DEFAULT_SYNC_END, help="End date YYYY-MM-DD")
    parser.add_argument(
        "--delay",
        type=float,
        default=1.5,
        help="Seconds to wait between runs (default: 1.5)",
    )
    parser.add_argument(
        "--rate-limit-wait",
        type=int,
        default=DEFAULT_RATE_LIMIT_WAIT_S,
        help="Seconds to wait when Strava returns 429 (default: 900 = 15 min)",
    )
    args = parser.parse_args()

    token = get_valid_access_token()
    if not token:
        print(
            "Not connected to Strava.\n"
            "Start the server (python server.py), open http://localhost:5000/maps,\n"
            "click trail analysis, and connect Strava — then run this script again."
        )
        return 1

    try:
        result = download_runs(
            token,
            start_date=args.start,
            end_date=args.end,
            delay_s=args.delay,
            rate_limit_wait_s=args.rate_limit_wait,
        )
    except ValueError as exc:
        print(f"Error: {exc}")
        return 1

    return 1 if result["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
