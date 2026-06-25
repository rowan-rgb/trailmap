"""Strava OAuth helpers and activity fetching."""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests

STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize"
STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
STRAVA_API = "https://www.strava.com/api/v3"
TOKEN_PATH = Path(__file__).resolve().parent / ".data" / "strava_tokens.json"
DEFAULT_SCOPES = "activity:read_all,read"


def has_client_credentials() -> bool:
    return bool(os.getenv("STRAVA_CLIENT_ID", "").strip() and os.getenv("STRAVA_CLIENT_SECRET", "").strip())


def clear_tokens() -> None:
    if TOKEN_PATH.exists():
        TOKEN_PATH.unlink()


def _client_id() -> str:
    client_id = os.getenv("STRAVA_CLIENT_ID", "").strip()
    if not client_id:
        raise RuntimeError("STRAVA_CLIENT_ID is not set. Copy .env.example to .env and add your Strava app credentials.")
    return client_id


def _client_secret() -> str:
    client_secret = os.getenv("STRAVA_CLIENT_SECRET", "")
    if not client_secret:
        raise RuntimeError("STRAVA_CLIENT_SECRET is not set. Copy .env.example to .env and add your Strava app credentials.")
    return client_secret


def redirect_uri() -> str:
    return os.getenv("STRAVA_REDIRECT_URI", "http://localhost:5000/auth/strava/callback")


def authorization_url(*, force_approval: bool = False) -> str:
    params = {
        "client_id": _client_id(),
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "approval_prompt": "force" if force_approval else "auto",
        "scope": DEFAULT_SCOPES,
    }
    return f"{STRAVA_AUTH_URL}?{urlencode(params)}"


def load_tokens() -> dict[str, Any] | None:
    if not TOKEN_PATH.exists():
        return None
    return json.loads(TOKEN_PATH.read_text(encoding="utf-8"))


def save_tokens(data: dict[str, Any]) -> None:
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def exchange_code(code: str) -> dict[str, Any]:
    response = requests.post(
        STRAVA_TOKEN_URL,
        data={
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "code": code,
            "grant_type": "authorization_code",
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    payload["expires_at_epoch"] = int(time.time()) + int(payload.get("expires_in", 21600))
    save_tokens(payload)
    return payload


def refresh_access_token(refresh_token: str) -> dict[str, Any]:
    response = requests.post(
        STRAVA_TOKEN_URL,
        data={
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    payload["expires_at_epoch"] = int(time.time()) + int(payload.get("expires_in", 21600))
    save_tokens(payload)
    return payload


def get_valid_access_token() -> str | None:
    tokens = load_tokens()
    if not tokens:
        return None

    expires_at = int(tokens.get("expires_at_epoch", 0))
    if expires_at - 120 > int(time.time()):
        return tokens["access_token"]

    refreshed = refresh_access_token(tokens["refresh_token"])
    return refreshed["access_token"]


def token_has_activity_scope(tokens: dict[str, Any] | None = None) -> bool:
    payload = tokens or load_tokens() or {}
    scope = str(payload.get("scope", ""))
    return "activity:read_all" in scope or "activity:read" in scope


def is_connected() -> bool:
    return get_valid_access_token() is not None


def can_read_activities(access_token: str) -> bool:
    response = requests.get(
        f"{STRAVA_API}/athlete/activities",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"page": 1, "per_page": 1},
        timeout=30,
    )
    if response.status_code == 429:
        return token_has_activity_scope()
    return response.status_code == 200


def get_athlete(access_token: str) -> dict[str, Any]:
    response = requests.get(
        f"{STRAVA_API}/athlete",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def get_activities(access_token: str, *, page: int = 1, per_page: int = 50) -> list[dict[str, Any]]:
    response = requests.get(
        f"{STRAVA_API}/athlete/activities",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"page": page, "per_page": per_page},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lng2 - lng1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def activities_near_trail_pulse(
    access_token: str,
    *,
    center_lat: float,
    center_lng: float,
    max_km: float = 20.0,
    max_results: int = 8,
) -> list[dict[str, Any]]:
    trail_types = {"Run", "TrailRun", "Hike", "Walk", "Ride", "MountainBikeRide"}
    nearby: list[dict[str, Any]] = []

    for page in range(1, 4):
        activities = get_activities(access_token, page=page, per_page=50)
        if not activities:
            break

        for activity in activities:
            start = activity.get("start_latlng") or []
            if len(start) != 2:
                continue

            activity_lat, activity_lng = start[0], start[1]
            distance_km = haversine_km(center_lat, center_lng, activity_lat, activity_lng)
            if distance_km > max_km:
                continue
            if activity.get("type") not in trail_types:
                continue

            nearby.append(
                {
                    "id": activity.get("id"),
                    "name": activity.get("name"),
                    "type": activity.get("type"),
                    "distance_km": round((activity.get("distance") or 0) / 1000, 2),
                    "moving_time_min": round((activity.get("moving_time") or 0) / 60, 1),
                    "start_date": activity.get("start_date_local") or activity.get("start_date"),
                    "distance_from_pulse_km": round(distance_km, 2),
                }
            )

        if len(nearby) >= max_results:
            break

    nearby.sort(key=lambda item: item["start_date"] or "", reverse=True)
    return nearby[:max_results]
