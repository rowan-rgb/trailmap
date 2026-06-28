"""Local dev server: serves the map and handles Strava OAuth + API."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, request, send_from_directory

import strava_client as strava

ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output"
MAP_FILE = "cape_town_map.html"

load_dotenv(ROOT / ".env")

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-only-change-me")


def _env_flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes", "on")


def _public_demo() -> bool:
    return _env_flag("PUBLIC_DEMO")


def _trail_map_only() -> bool:
    return _env_flag("TRAIL_MAP_ONLY")


def ensure_map_html() -> None:
    map_path = OUTPUT_DIR / MAP_FILE
    source_path = ROOT / "map_cape_town.py"
    needs_build = not map_path.exists()
    if map_path.exists() and source_path.exists():
        needs_build = source_path.stat().st_mtime > map_path.stat().st_mtime
    if needs_build:
        subprocess.run([sys.executable, str(source_path)], check=True, cwd=ROOT)


def _strava_setup_error() -> str | None:
    if not os.getenv("STRAVA_CLIENT_ID", "").strip():
        return "STRAVA_CLIENT_ID is missing from .env"
    if not os.getenv("STRAVA_CLIENT_SECRET", "").strip():
        return "STRAVA_CLIENT_SECRET is missing from .env"
    return None


@app.get("/")
def index():
    if _trail_map_only():
        return redirect("/maps")
    return send_from_directory(ROOT / "static", "index.html")


@app.get("/health")
def health():
    from strava_cache import get_status

    status = get_status()
    return jsonify(
        {
            "ok": True,
            "public_demo": _public_demo(),
            "trail_map_only": _trail_map_only(),
            "cached_runs": status.get("run_count", 0),
        }
    )


@app.get("/api/config")
def public_config():
    return jsonify(
        {
            "public_demo": _public_demo(),
            "trail_map_only": _trail_map_only(),
            "auto_open_trail": _trail_map_only(),
        }
    )


@app.get("/background")
def background_view():
    return send_from_directory(ROOT / "static", "background.html")


@app.get("/maps")
def maps_view():
    ensure_map_html()
    return send_from_directory(OUTPUT_DIR, MAP_FILE)


@app.get("/maps/trail")
def maps_trail_view():
    """Trail analysis opens from the map; allow direct URL only after Strava OAuth."""
    ensure_map_html()
    if request.args.get("strava") == "connected":
        return send_from_directory(OUTPUT_DIR, MAP_FILE)
    return redirect("/maps")


@app.get("/auth/strava")
def auth_strava():
    setup_error = _strava_setup_error()
    if setup_error:
        return redirect(f"/maps?strava=setup_error&detail={setup_error.replace(' ', '%20')}")
    return redirect(strava.authorization_url(force_approval=True))


@app.get("/auth/strava/reconnect")
def auth_strava_reconnect():
    setup_error = _strava_setup_error()
    if setup_error:
        return redirect(f"/maps?strava=setup_error&detail={setup_error.replace(' ', '%20')}")
    strava.clear_tokens()
    return redirect(strava.authorization_url(force_approval=True))


@app.get("/auth/strava/callback")
def auth_strava_callback():
    error = request.args.get("error")
    if error:
        return redirect("/maps?strava=denied")

    code = request.args.get("code")
    if not code:
        return redirect("/maps?strava=missing_code")

    try:
        strava.exchange_code(code)
    except Exception:
        return redirect("/maps?strava=exchange_failed")

    return redirect("/maps/trail?strava=connected")


@app.get("/api/strava/status")
def strava_status():
    """Local token check only — does not call the Strava API."""
    setup_error = _strava_setup_error()
    if setup_error:
        return jsonify({"connected": False, "setup_error": setup_error, "activity_access": False})

    tokens = strava.load_tokens()
    if not tokens or not tokens.get("access_token"):
        return jsonify({"connected": False, "activity_access": False})

    return jsonify(
        {
            "connected": True,
            "activity_access": strava.token_has_activity_scope(tokens),
        }
    )


@app.get("/static/<path:filename>")
def static_files(filename: str):
    return send_from_directory(ROOT / "static", filename)


@app.get("/api/strava/runs/timeline")
def strava_runs_timeline():
    from strava_cache import get_status, timeline_from_cache

    start_date = request.args.get("start", "").strip()
    end_date = request.args.get("end", "").strip()
    if not start_date or not end_date:
        return jsonify({"message": "Provide start and end query params (YYYY-MM-DD)."}), 400

    cache_status = get_status()
    if cache_status["run_count"] == 0:
        return jsonify(
            {
                "message": "No runs stored locally yet. Click sync latest from Strava.",
                "needs_sync": True,
                "cache": cache_status,
            }
        ), 404

    try:
        payload = timeline_from_cache(start_date, end_date)
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    payload["cache"] = cache_status
    return jsonify(payload)


@app.get("/api/strava/cache/status")
def strava_cache_status():
    from strava_cache import get_status

    return jsonify(get_status())


@app.post("/api/strava/cache/sync")
def strava_cache_sync():
    if _public_demo():
        return jsonify({"message": "Sync is disabled on the public demo."}), 403

    from strava_cache import DEFAULT_SYNC_END, DEFAULT_SYNC_START, prepare_sync, sync_batch

    setup_error = _strava_setup_error()
    if setup_error:
        return jsonify({"connected": False, "message": setup_error}), 400

    token = strava.get_valid_access_token()
    if not token:
        return jsonify({"connected": False, "message": "Connect Strava first."}), 401

    if not strava.can_read_activities(token):
        return jsonify(
            {
                "connected": True,
                "activity_access": False,
                "message": "Re-authorize Strava to read activities.",
            }
        ), 403

    data = request.get_json(silent=True) or {}
    start_date = str(data.get("start_date") or DEFAULT_SYNC_START).strip()
    end_date = str(data.get("end_date") or DEFAULT_SYNC_END).strip()
    batch_size = int(data.get("batch_size") or 5)
    reset = bool(data.get("reset"))

    try:
        if reset or data.get("prepare"):
            prepare_result = prepare_sync(token, start_date=start_date, end_date=end_date)
            if prepare_result.get("complete"):
                return jsonify(prepare_result)

        result = sync_batch(
            token,
            batch_size=batch_size,
            start_date=start_date,
            end_date=end_date,
        )
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 429:
            return jsonify(
                {
                    "message": (
                        "Strava API rate limit reached. "
                        "Wait about 15 minutes, then click sync again to continue."
                    ),
                    "rate_limited": True,
                }
            ), 429
        return jsonify({"message": f"Strava API error: {exc}"}), 502
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"message": str(exc)}), 502

    return jsonify(result)


@app.get("/api/strava/runs/timeline/live")
def strava_runs_timeline_live():
    """Fetch runs directly from Strava (slow; mainly for debugging)."""
    from strava_routes import fetch_runs_timeline

    setup_error = _strava_setup_error()
    if setup_error:
        return jsonify({"connected": False, "message": setup_error}), 400

    start_date = request.args.get("start", "").strip()
    end_date = request.args.get("end", "").strip()
    if not start_date or not end_date:
        return jsonify({"message": "Provide start and end query params (YYYY-MM-DD)."}), 400

    token = strava.get_valid_access_token()
    if not token:
        return jsonify({"connected": False, "message": "Connect Strava first."}), 401

    if not strava.can_read_activities(token):
        return jsonify(
            {
                "connected": True,
                "activity_access": False,
                "message": "Re-authorize Strava to read activities.",
            }
        ), 403

    try:
        payload = fetch_runs_timeline(token, start_date=start_date, end_date=end_date)
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 429:
            return jsonify(
                {
                    "message": (
                        "Strava API rate limit reached. "
                        "Wait about 15 minutes before loading runs again."
                    ),
                    "rate_limited": True,
                }
            ), 429
        return jsonify({"message": f"Strava API error: {exc}"}), 502

    return jsonify(payload)


@app.get("/api/strava/segments/from-runs")
def strava_segments_from_runs():
    """Segment geometry from cached run segment_efforts (no Strava API)."""
    from strava_cache import segments_from_cache

    segment_ids_raw = request.args.get("segment_ids", "")
    segment_ids = [
        int(value)
        for value in segment_ids_raw.split(",")
        if value.strip().isdigit()
    ]
    if not segment_ids:
        return jsonify({"segments": []})

    return jsonify(segments_from_cache(segment_ids))


@app.get("/api/strava/trail-pulse")
def strava_trail_pulse():
    from map_cape_town import TRAIL_PULSE

    setup_error = _strava_setup_error()
    if setup_error:
        return jsonify({"connected": False, "message": setup_error}), 400

    token = strava.get_valid_access_token()
    if not token:
        return jsonify({"connected": False, "message": "Connect Strava first."}), 401

    if not strava.can_read_activities(token):
        return jsonify(
            {
                "connected": True,
                "activity_access": False,
                "message": (
                    "Your Strava token cannot read activities. "
                    "Use 're-authorize strava' to grant activity:read_all permission."
                ),
            }
        ), 403

    try:
        activities = strava.activities_near_trail_pulse(
            token,
            center_lat=TRAIL_PULSE["latitude"],
            center_lng=TRAIL_PULSE["longitude"],
        )
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 401:
            return jsonify(
                {
                    "connected": True,
                    "activity_access": False,
                    "message": "Strava authorization expired. Re-authorize to continue.",
                }
            ), 403
        raise

    return jsonify(
        {
            "connected": True,
            "activity_access": True,
            "marker": "trail analysis",
            "center": {
                "lat": TRAIL_PULSE["latitude"],
                "lng": TRAIL_PULSE["longitude"],
            },
            "activities": activities,
        }
    )


@app.get("/api/trail/coach/status")
def trail_coach_status():
    from trail_coach import is_configured

    return jsonify({"configured": is_configured()})


@app.post("/api/trail/coach/chat")
def trail_coach_chat():
    from trail_coach import ask_coach, is_configured

    if not is_configured():
        return jsonify({"message": "OPENAI_API_KEY is not set in .env"}), 503

    data = request.get_json(silent=True) or {}
    question = str(data.get("question") or "").strip()
    runs = data.get("runs") or []
    if not question:
        return jsonify({"message": "Question is required."}), 400
    if not runs:
        return jsonify({"message": "No runs provided."}), 400

    try:
        result = ask_coach(
            question,
            runs,
            summary=data.get("summary"),
            start_date=data.get("start_date"),
            end_date=data.get("end_date"),
        )
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"message": str(exc)}), 502

    return jsonify(result)


@app.post("/api/trail/utct-opinion")
def trail_utct_opinion():
    from trail_coach import is_configured, utct_opinion

    if not is_configured():
        return jsonify({"message": "OPENAI_API_KEY is not set in .env"}), 503

    data = request.get_json(silent=True) or {}
    runs = data.get("runs") or []
    if not runs:
        return jsonify({"message": "No runs provided."}), 400

    try:
        result = utct_opinion(
            runs,
            summary=data.get("summary"),
            start_date=data.get("start_date"),
            end_date=data.get("end_date"),
        )
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"message": str(exc)}), 502

    return jsonify(result)


def _print_startup_help() -> None:
    ensure_map_html()
    print("Home:  http://localhost:5000/")
    print("Maps:  http://localhost:5000/maps")
    print("Click 'trail analysis' on the map to connect Strava.")
    setup_error = _strava_setup_error()
    if setup_error:
        print("\n[!] Strava setup incomplete:")
        print(f"    {setup_error}")
        print("    Get Client ID + Secret: https://www.strava.com/settings/api")
        print("    Set Authorization Callback Domain to: localhost")
        print("    Then add STRAVA_CLIENT_ID to .env and restart this server.")
    try:
        from trail_coach import is_configured

        if not is_configured():
            print("\n[i] UTCT AI coach: add OPENAI_API_KEY to .env to enable run analysis.")
    except Exception:
        pass


if __name__ == "__main__":
    _print_startup_help()
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "").strip().lower() in ("1", "true", "yes")
    app.run(host="127.0.0.1", port=port, debug=debug)
