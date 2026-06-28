"""Fetch Strava runs with GPS streams for timeline visualization."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
import time
from typing import Any

import requests

from strava_client import strava_get

RUN_TYPES = {"Run", "TrailRun"}
MAX_POINTS_PER_RUN = 220
MAX_SEGMENT_DETAIL_FETCH = 40

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


def get_activity_detail(access_token: str, activity_id: int) -> dict[str, Any]:
    response = strava_get(access_token, f"activities/{activity_id}")
    return response.json()


def get_activity_streams(access_token: str, activity_id: int) -> dict[str, list[Any]]:
    response = strava_get(
        access_token,
        f"activities/{activity_id}/streams",
        params={
            "keys": "latlng,altitude,distance,time,heartrate,watts,velocity_smooth",
            "key_by_type": "true",
        },
    )
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


def list_runs_in_range(
    access_token: str,
    *,
    after_epoch: int,
    before_epoch: int,
    max_runs: int | None = None,
    rate_limit_wait_s: int = 900,
    on_rate_limit: Callable[[int, requests.Response], None] | None = None,
) -> list[dict[str, Any]]:
    """List Run/TrailRun activities in a date range (paginates through Strava API)."""
    runs: list[dict[str, Any]] = []
    page = 1

    while page <= 100:
        response = strava_get(
            access_token,
            "athlete/activities",
            params={
                "page": page,
                "per_page": 200,
                "after": after_epoch,
                "before": before_epoch,
            },
            rate_limit_wait_s=rate_limit_wait_s,
            on_rate_limit=on_rate_limit,
        )
        activities = response.json()
        if not activities:
            break

        for activity in activities:
            if activity.get("type") not in RUN_TYPES:
                continue
            runs.append(activity)
            if max_runs is not None and len(runs) >= max_runs:
                return runs

        if len(activities) < 200:
            break
        page += 1

    runs.sort(key=lambda item: item.get("start_date") or "")
    return runs


def fetch_single_run_by_id(
    access_token: str,
    activity_id: int,
    *,
    color_index: int = 0,
) -> dict[str, Any] | None:
    detail = get_activity_detail(access_token, activity_id)
    if detail.get("type") not in RUN_TYPES:
        return None

    streams = get_activity_streams(access_token, activity_id)
    latlng = streams.get("latlng") or []
    count = len(latlng)
    distance = list(streams.get("distance") or range(count))
    altitude = list(streams.get("altitude") or [0] * count)
    distance = (distance + [distance[-1] if distance else 0])[:count]
    altitude = (altitude + [altitude[-1] if altitude else 0])[:count]

    segment_efforts = []
    for item in detail.get("segment_efforts") or []:
        normalized = _normalize_segment_effort(item)
        if not normalized:
            continue
        normalized["elevation_profile"] = _extract_elevation_profile(
            distance,
            altitude,
            item.get("start_index"),
            item.get("end_index"),
        )
        normalized["path"] = _extract_segment_path(
            latlng,
            item.get("start_index"),
            item.get("end_index"),
        )
        segment_efforts.append(normalized)

    run = _build_run_record(
        detail,
        streams,
        ROUTE_COLORS[color_index % len(ROUTE_COLORS)],
    )
    if run:
        run["segment_efforts"] = segment_efforts
    return run


def build_timeline_payload(
    runs: list[dict[str, Any]],
    *,
    start_date: str,
    end_date: str,
    source: str = "cache",
    skipped: list[str] | None = None,
) -> dict[str, Any]:
    for index, run in enumerate(runs):
        run["color"] = ROUTE_COLORS[index % len(ROUTE_COLORS)]

    total_distance_km = round(sum(run["distance_km"] for run in runs), 2)
    total_elevation_gain_m = round(sum(run.get("elevation_gain_m", 0) for run in runs), 1)

    return {
        "start_date": start_date,
        "end_date": end_date,
        "runs": runs,
        "bounds": _bounds_from_runs(runs),
        "source": source,
        "summary": {
            "run_count": len(runs),
            "total_distance_km": total_distance_km,
            "total_elevation_gain_m": total_elevation_gain_m,
            "skipped": skipped or [],
        },
    }


def _fill_stream(values: list[Any], count: int, default: Any = None) -> list[Any]:
    if count <= 0:
        return []
    if not values:
        return [default] * count
    if len(values) >= count:
        return values[:count]
    return (values + [values[-1]] * count)[:count]


def _build_run_record(activity: dict[str, Any], streams: dict[str, list[Any]], color: list[int]) -> dict[str, Any] | None:
    latlng = streams.get("latlng") or []
    if len(latlng) < 2:
        return None

    count = len(latlng)
    altitude = _fill_stream(streams.get("altitude") or [], count, 0)
    distance = _fill_stream(streams.get("distance") or [], count, 0)
    if not streams.get("distance"):
        distance = [float(index) for index in range(count)]
    elapsed = _fill_stream(streams.get("time") or [], count, 0)
    if not streams.get("time"):
        elapsed = [float(index) for index in range(count)]
    heartrate = _fill_stream(streams.get("heartrate") or [], count, None)
    watts = _fill_stream(streams.get("watts") or [], count, None)
    velocity = _fill_stream(streams.get("velocity_smooth") or [], count, None)

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
        "path_stream_indices": sampled,
        "distance_m": distance_m,
        "altitude_m": [round(value, 1) for value in altitude_m],
        "elapsed_s": elapsed_s,
        "heartrate_bpm": heartrate_bpm,
        "watts": watts_w,
        "velocity_mps": velocity_mps,
        "segments": segments,
    }


def _decode_polyline(polyline_str: str) -> list[list[float]]:
    coordinates: list[list[float]] = []
    index = 0
    lat = 0
    lng = 0
    length = len(polyline_str)

    while index < length:
        shift = 0
        result = 0
        while True:
            byte = ord(polyline_str[index]) - 63
            index += 1
            result |= (byte & 0x1F) << shift
            shift += 5
            if byte < 0x20:
                break
        delta_lat = ~(result >> 1) if result & 1 else (result >> 1)
        lat += delta_lat

        shift = 0
        result = 0
        while True:
            byte = ord(polyline_str[index]) - 63
            index += 1
            result |= (byte & 0x1F) << shift
            shift += 5
            if byte < 0x20:
                break
        delta_lng = ~(result >> 1) if result & 1 else (result >> 1)
        lng += delta_lng
        coordinates.append([lat / 1e5, lng / 1e5])

    return coordinates


def _extract_elevation_profile(
    distance_m: list[float],
    altitude_m: list[float],
    start_index: int | None,
    end_index: int | None,
    *,
    max_points: int = 80,
) -> list[dict[str, float]]:
    if start_index is None or end_index is None:
        return []
    start = int(start_index)
    end = min(int(end_index), len(distance_m) - 1)
    if end <= start or start < 0:
        return []

    base_dist = distance_m[start]
    indices = list(range(start, end + 1))
    profile: list[dict[str, float]] = []
    for index in _downsample(indices, max_points):
        profile.append(
            {
                "distance_m": round(distance_m[index] - base_dist, 1),
                "altitude_m": round(float(altitude_m[index]), 1),
            }
        )
    return profile


def _extract_segment_path(
    latlng: list[list[float]],
    start_index: int | None,
    end_index: int | None,
    *,
    max_points: int = 80,
) -> list[list[float]]:
    if start_index is None or end_index is None or not latlng:
        return []
    start = int(start_index)
    end = min(int(end_index), len(latlng) - 1)
    if end <= start or start < 0:
        return []

    indices = list(range(start, end + 1))
    path: list[list[float]] = []
    for index in _downsample(indices, max_points):
        point = latlng[index]
        path.append([point[1], point[0]])
    return path


def _normalize_segment_effort(effort: dict[str, Any]) -> dict[str, Any] | None:
    segment = effort.get("segment") or {}
    segment_id = segment.get("id")
    if not segment_id:
        return None

    distance_m = float(effort.get("distance") or segment.get("distance") or 0)
    elapsed_s = int(effort.get("elapsed_time") or 0)
    pace_min_per_km = None
    if distance_m > 50 and elapsed_s > 0:
        pace_min_per_km = round((elapsed_s / 60) / (distance_m / 1000), 2)

    return {
        "segment_id": int(segment_id),
        "segment_name": segment.get("name"),
        "elapsed_s": elapsed_s,
        "distance_m": round(distance_m, 1),
        "pace_min_per_km": pace_min_per_km,
        "start_date": effort.get("start_date") or effort.get("start_date_local"),
        "start_index": effort.get("start_index"),
        "end_index": effort.get("end_index"),
        "pr_rank": effort.get("pr_rank"),
        "kom_rank": effort.get("kom_rank"),
    }


def explore_segments(access_token: str, bounds: dict[str, float]) -> list[dict[str, Any]]:
    response = strava_get(
        access_token,
        "segments/explore",
        params={
            "bounds": (
                f"{bounds['min_lat']},{bounds['min_lng']},"
                f"{bounds['max_lat']},{bounds['max_lng']}"
            ),
            "activity_type": "running",
        },
    )
    payload = response.json()
    return payload.get("segments") or []


def get_segment_detail(access_token: str, segment_id: int) -> dict[str, Any]:
    response = strava_get(access_token, f"segments/{segment_id}")
    return response.json()


def fetch_run_segments(
    access_token: str,
    segment_ids: list[int],
    *,
    max_wait_s: float = 8.0,
) -> dict[str, Any]:
    unique_ids = list(dict.fromkeys(int(item) for item in segment_ids if item))[:MAX_SEGMENT_DETAIL_FETCH]
    segments: list[dict[str, Any]] = []
    deadline = time.monotonic() + max_wait_s

    for segment_id in unique_ids:
        if time.monotonic() >= deadline:
            break
        try:
            detail = get_segment_detail(access_token, segment_id)
        except requests.HTTPError:
            continue

        polyline = (detail.get("map") or {}).get("polyline")
        path: list[list[float]] = []
        if polyline:
            path = [[point[1], point[0]] for point in _decode_polyline(polyline)]

        segments.append(
            {
                "id": detail.get("id"),
                "name": detail.get("name"),
                "distance_km": round((detail.get("distance") or 0) / 1000, 2),
                "avg_grade": detail.get("average_grade"),
                "climb_category": detail.get("climb_category"),
                "path": path,
            }
        )

    return {"segments": segments}


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
    max_runs: int | None = None,
) -> dict[str, Any]:
    after_epoch = _parse_date(start_date)
    before_epoch = _parse_date(end_date, end_of_day=True)

    if after_epoch >= before_epoch:
        raise ValueError("start_date must be before end_date")

    activities = list_runs_in_range(
        access_token,
        after_epoch=after_epoch,
        before_epoch=before_epoch,
        max_runs=max_runs,
    )
    runs: list[dict[str, Any]] = []
    skipped: list[str] = []

    for index, activity in enumerate(activities):
        try:
            run = fetch_single_run_by_id(
                access_token,
                int(activity["id"]),
                color_index=index,
            )
            if run:
                runs.append(run)
            else:
                skipped.append(activity.get("name") or str(activity.get("id")))
        except requests.HTTPError:
            skipped.append(activity.get("name") or str(activity.get("id")))

    return build_timeline_payload(
        runs,
        start_date=start_date,
        end_date=end_date,
        source="strava",
        skipped=skipped,
    )
