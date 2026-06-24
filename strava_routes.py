"""Fetch Strava runs with GPS streams for timeline visualization."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import requests

from strava_client import STRAVA_API

RUN_TYPES = {"Run", "TrailRun"}
MAX_RUNS = 25
MAX_POINTS_PER_RUN = 220

ROUTE_COLORS = [
    [252, 76, 2],
    [0, 128, 255],
    [46, 184, 92],
    [155, 89, 182],
    [241, 196, 15],
    [231, 76, 60],
    [26, 188, 156],
    [52, 73, 94],
]


def _parse_date(date_str: str, *, end_of_day: bool = False) -> int:
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    if end_of_day:
        dt = dt.replace(hour=23, minute=59, second=59)
    return int(dt.replace(tzinfo=timezone.utc).timestamp())


def _downsample(values: list[Any], max_points: int) -> list[Any]:
    if len(values) <= max_points:
        return values
    step = (len(values) - 1) / (max_points - 1)
    return [values[round(i * step)] for i in range(max_points)]


def get_activity_streams(access_token: str, activity_id: int) -> dict[str, list[Any]]:
    response = requests.get(
        f"{STRAVA_API}/activities/{activity_id}/streams",
        headers={"Authorization": f"Bearer {access_token}"},
        params={
            "keys": "latlng,altitude,distance,time,heartrate,watts,velocity_smooth",
            "key_by_type": "true",
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()

    if isinstance(payload, list):
        by_type = {item["type"]: item.get("data", []) for item in payload}
    else:
        by_type = {key: value.get("data", []) for key, value in payload.items()}

    return {
        "latlng": by_type.get("latlng", []),
        "altitude": by_type.get("altitude", []),
        "distance": by_type.get("distance", []),
        "time": by_type.get("time", []),
        "heartrate": by_type.get("heartrate", []),
        "watts": by_type.get("watts", []),
        "velocity_smooth": by_type.get("velocity_smooth", []),
    }


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round((pct / 100) * (len(ordered) - 1))))
    return float(ordered[index])


def _merge_ranges(flags: list[bool], *, min_len: int = 2) -> list[list[int]]:
    ranges: list[list[int]] = []
    start: int | None = None
    for index, active in enumerate(flags):
        if active and start is None:
            start = index
        elif not active and start is not None:
            if index - start >= min_len:
                ranges.append([start, index - 1])
            start = None
    if start is not None and len(flags) - start >= min_len:
        ranges.append([start, len(flags) - 1])
    return ranges


def _analyze_run_segments(
    *,
    distance_m: list[float],
    altitude_m: list[float],
    elapsed_s: list[float],
    heartrate_bpm: list[float | None],
    watts: list[float | None],
    velocity_mps: list[float | None],
) -> dict[str, Any]:
    count = len(distance_m)
    speeds: list[float] = []
    grades: list[float] = []

    for index in range(count):
        if index >= count - 1:
            speeds.append(speeds[-1] if speeds else 0.0)
            grades.append(grades[-1] if grades else 0.0)
            continue

        dist_delta = max(distance_m[index + 1] - distance_m[index], 0.0)
        time_delta = max(elapsed_s[index + 1] - elapsed_s[index], 0.001)
        alt_delta = altitude_m[index + 1] - altitude_m[index]

        if velocity_mps[index + 1] is not None:
            speed = float(velocity_mps[index + 1])
        else:
            speed = dist_delta / time_delta

        grade = (alt_delta / dist_delta) * 100 if dist_delta > 0.5 else 0.0
        speeds.append(max(speed, 0.0))
        grades.append(grade)

    speed_samples = [speed for speed in speeds if speed > 0.8]
    speed_threshold = _percentile(speed_samples, 75) if speed_samples else 3.5
    climb_flags = [grade >= 4.0 for grade in grades]
    speed_flags = [speed >= speed_threshold and speed >= 1.8 for speed in speeds]

    hr_values = [float(value) for value in heartrate_bpm if value is not None and value > 0]
    hr_flags: list[bool] = []
    hr_threshold = 0.0
    if hr_values:
        hr_threshold = _percentile(hr_values, 75)
        hr_flags = [value is not None and value >= hr_threshold for value in heartrate_bpm]
    else:
        hr_flags = [False] * count

    power_values = [float(value) for value in watts if value is not None and value > 0]
    power_flags: list[bool] = []
    power_threshold = 0.0
    if power_values:
        power_threshold = _percentile(power_values, 75)
        power_flags = [value is not None and value >= power_threshold for value in watts]
    else:
        power_flags = [False] * count

    return {
        "climbing": _merge_ranges(climb_flags),
        "high_speed": _merge_ranges(speed_flags),
        "high_hr": _merge_ranges(hr_flags) if hr_values else [],
        "high_power": _merge_ranges(power_flags) if power_values else [],
        "has_heartrate": bool(hr_values),
        "has_power": bool(power_values),
        "thresholds": {
            "speed_mps": round(speed_threshold, 2),
            "grade_pct": 4.0,
            "heartrate_bpm": round(hr_threshold, 1) if hr_values else None,
            "power_w": round(power_threshold, 1) if power_values else None,
        },
    }


def _list_runs_in_range(
    access_token: str,
    *,
    after_epoch: int,
    before_epoch: int,
) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []

    for page in range(1, 6):
        response = requests.get(
            f"{STRAVA_API}/athlete/activities",
            headers={"Authorization": f"Bearer {access_token}"},
            params={
                "page": page,
                "per_page": 50,
                "after": after_epoch,
                "before": before_epoch,
            },
            timeout=30,
        )
        response.raise_for_status()
        activities = response.json()
        if not activities:
            break

        for activity in activities:
            if activity.get("type") not in RUN_TYPES:
                continue
            runs.append(activity)
            if len(runs) >= MAX_RUNS:
                return runs

    runs.sort(key=lambda item: item.get("start_date") or "")
    return runs


def _build_run_record(activity: dict[str, Any], streams: dict[str, list[Any]], color: list[int]) -> dict[str, Any] | None:
    latlng = streams.get("latlng") or []
    if len(latlng) < 2:
        return None

    altitude = streams.get("altitude") or [0] * len(latlng)
    distance = streams.get("distance") or list(range(len(latlng)))
    elapsed = streams.get("time") or list(range(len(latlng)))
    heartrate = streams.get("heartrate") or []
    watts = streams.get("watts") or []
    velocity = streams.get("velocity_smooth") or []

    count = len(latlng)
    altitude = (altitude + [altitude[-1] if altitude else 0])[:count]
    distance = (distance + [distance[-1] if distance else 0])[:count]
    elapsed = (elapsed + [elapsed[-1] if elapsed else 0])[:count]
    heartrate = (heartrate + [heartrate[-1] if heartrate else None])[:count]
    watts = (watts + [watts[-1] if watts else None])[:count]
    velocity = (velocity + [velocity[-1] if velocity else None])[:count]

    indices = list(range(count))
    sampled = _downsample(indices, MAX_POINTS_PER_RUN)

    path = [[point[1], point[0]] for point in (latlng[i] for i in sampled)]
    distance_m = [distance[i] for i in sampled]
    altitude_m = [altitude[i] for i in sampled]
    elapsed_s = [elapsed[i] for i in sampled]
    heartrate_bpm = [heartrate[i] for i in sampled]
    watts_w = [watts[i] for i in sampled]
    velocity_mps = [velocity[i] for i in sampled]

    elevation_gain_m = round(float(activity.get("total_elevation_gain") or 0), 1)
    segments = _analyze_run_segments(
        distance_m=distance_m,
        altitude_m=altitude_m,
        elapsed_s=elapsed_s,
        heartrate_bpm=heartrate_bpm,
        watts=watts_w,
        velocity_mps=velocity_mps,
    )

    return {
        "id": activity.get("id"),
        "name": activity.get("name"),
        "type": activity.get("type"),
        "start_date": activity.get("start_date_local") or activity.get("start_date"),
        "distance_km": round((activity.get("distance") or distance_m[-1] or 0) / 1000, 2),
        "elevation_gain_m": elevation_gain_m,
        "average_heartrate": activity.get("average_heartrate"),
        "max_heartrate": activity.get("max_heartrate"),
        "average_watts": activity.get("average_watts"),
        "max_watts": activity.get("max_watts"),
        "color": color,
        "path": path,
        "distance_m": distance_m,
        "altitude_m": [round(value, 1) for value in altitude_m],
        "elapsed_s": elapsed_s,
        "heartrate_bpm": heartrate_bpm,
        "watts": watts_w,
        "velocity_mps": velocity_mps,
        "segments": segments,
    }


def _bounds_from_runs(runs: list[dict[str, Any]]) -> dict[str, float] | None:
    lngs: list[float] = []
    lats: list[float] = []
    for run in runs:
        for lng, lat in run["path"]:
            lngs.append(lng)
            lats.append(lat)
    if not lngs:
        return None
    return {
        "minLng": min(lngs),
        "maxLng": max(lngs),
        "minLat": min(lats),
        "maxLat": max(lats),
    }


def fetch_runs_timeline(
    access_token: str,
    *,
    start_date: str,
    end_date: str,
) -> dict[str, Any]:
    after_epoch = _parse_date(start_date)
    before_epoch = _parse_date(end_date, end_of_day=True)

    if after_epoch >= before_epoch:
        raise ValueError("start_date must be before end_date")

    activities = _list_runs_in_range(access_token, after_epoch=after_epoch, before_epoch=before_epoch)
    runs: list[dict[str, Any]] = []
    skipped: list[str] = []

    for index, activity in enumerate(activities):
        try:
            streams = get_activity_streams(access_token, int(activity["id"]))
            run = _build_run_record(activity, streams, ROUTE_COLORS[index % len(ROUTE_COLORS)])
            if run:
                runs.append(run)
            else:
                skipped.append(activity.get("name") or str(activity.get("id")))
        except requests.HTTPError:
            skipped.append(activity.get("name") or str(activity.get("id")))

    bounds = _bounds_from_runs(runs)
    total_distance_km = round(sum(run["distance_km"] for run in runs), 2)
    total_elevation_gain_m = round(sum(run.get("elevation_gain_m", 0) for run in runs), 1)

    return {
        "start_date": start_date,
        "end_date": end_date,
        "runs": runs,
        "bounds": bounds,
        "summary": {
            "run_count": len(runs),
            "total_distance_km": total_distance_km,
            "total_elevation_gain_m": total_elevation_gain_m,
            "skipped": skipped,
        },
    }
