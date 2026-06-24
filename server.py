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


def ensure_map_html() -> None:
    map_path = OUTPUT_DIR / MAP_FILE
    if not map_path.exists():
        subprocess.run([sys.executable, str(ROOT / "map_cape_town.py")], check=True, cwd=ROOT)


def _strava_setup_error() -> str | None:
    if not os.getenv("STRAVA_CLIENT_ID", "").strip():
        return "STRAVA_CLIENT_ID is missing from .env"
    if not os.getenv("STRAVA_CLIENT_SECRET", "").strip():
        return "STRAVA_CLIENT_SECRET is missing from .env"
    return None


@app.get("/")
def index():
    ensure_map_html()
    return send_from_directory(OUTPUT_DIR, MAP_FILE)


@app.get("/auth/strava")
def auth_strava():
    setup_error = _strava_setup_error()
    if setup_error:
        return redirect(f"/?strava=setup_error&detail={setup_error.replace(' ', '%20')}")
    return redirect(strava.authorization_url(force_approval=True))


@app.get("/auth/strava/reconnect")
def auth_strava_reconnect():
    setup_error = _strava_setup_error()
    if setup_error:
        return redirect(f"/?strava=setup_error&detail={setup_error.replace(' ', '%20')}")
    strava.clear_tokens()
    return redirect(strava.authorization_url(force_approval=True))


@app.get("/auth/strava/callback")
def auth_strava_callback():
    error = request.args.get("error")
    if error:
        return redirect("/?strava=denied")

    code = request.args.get("code")
    if not code:
        return redirect("/?strava=missing_code")

    try:
        strava.exchange_code(code)
    except Exception:
        return redirect("/?strava=exchange_failed")

    return redirect("/?strava=connected")


@app.get("/api/strava/status")
def strava_status():
    setup_error = _strava_setup_error()
    if setup_error:
        return jsonify({"connected": False, "setup_error": setup_error, "activity_access": False})

    try:
        token = strava.get_valid_access_token()
        if not token:
            return jsonify({"connected": False, "activity_access": False})

        athlete = strava.get_athlete(token)
        activity_access = strava.can_read_activities(token)
        return jsonify(
            {
                "connected": True,
                "activity_access": activity_access,
                "athlete": {
                    "id": athlete.get("id"),
                    "firstname": athlete.get("firstname"),
                    "lastname": athlete.get("lastname"),
                },
            }
        )
    except Exception as exc:  # noqa: BLE001 - surface auth errors to the UI
        return jsonify({"connected": False, "activity_access": False, "error": str(exc)}), 500


@app.get("/static/<path:filename>")
def static_files(filename: str):
    return send_from_directory(ROOT / "static", filename)


@app.get("/api/strava/runs/timeline")
def strava_runs_timeline():
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
        return jsonify({"message": f"Strava API error: {exc}"}), 502

    return jsonify(payload)


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
            "marker": "trail pulse",
            "center": {
                "lat": TRAIL_PULSE["latitude"],
                "lng": TRAIL_PULSE["longitude"],
            },
            "activities": activities,
        }
    )


def _print_startup_help() -> None:
    ensure_map_html()
    print("Open http://localhost:5000")
    print("Click 'trail pulse' on the map to connect Strava.")
    setup_error = _strava_setup_error()
    if setup_error:
        print("\n[!] Strava setup incomplete:")
        print(f"    {setup_error}")
        print("    Get Client ID + Secret: https://www.strava.com/settings/api")
        print("    Set Authorization Callback Domain to: localhost")
        print("    Then add STRAVA_CLIENT_ID to .env and restart this server.")


if __name__ == "__main__":
    _print_startup_help()
    app.run(host="127.0.0.1", port=5000, debug=True)
