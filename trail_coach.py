"""AI coach for loaded Strava runs — Q&A and simple plots."""

from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from datetime import datetime
from typing import Any

from dotenv import load_dotenv

ROOT = __import__("pathlib").Path(__file__).resolve().parent
UTCT_TRAINING_PLAN_PATH = ROOT / "utct_training_plan.json"

UPCOMING_RACES = [
    {
        "name": "Bastille Day",
        "distance_km": 35,
        "elevation_m": 1350,
        "date": "2026-07-11",
        "priority": "B",
    },
    {
        "name": "Twin Peaks",
        "distance_km": 30,
        "elevation_m": 1600,
        "date": "2026-10-03",
        "priority": "B",
    },
    {
        "name": "Cape Cobra",
        "distance_km": 42,
        "elevation_m": 2200,
        "date": "2026-10-24",
        "priority": "B",
    },
    {
        "name": "UTCT",
        "distance_km": 35,
        "elevation_m": 1600,
        "date": "2026-11-22",
        "priority": "A-race",
        "notes": "~4h15 top-10 target",
    },
]

UTCT_QUESTION = "UTCT 35 km / 1,600 m — 22 Nov 2026 (A-race). Predicted finish time range for top-10 (~4h15)?"

SYSTEM_PROMPT = """You are a direct, slightly witty trail-running coach reviewing Rowan Davies's Strava training.
The user asks questions about the runs they loaded for a chosen date range.

Rules:
- Answer from the TRAINING DATA JSON (actual Strava runs) and the UTCT TRAINING PLAN JSON (Rowan's
  written build-up plan). Do not invent runs, dates, or metrics.
- Compare actual loaded runs against the plan where relevant: volume, vert, key sessions, and readiness
  for benchmark races and UTCT. Say clearly when the data cannot answer the question.
- Tone: supportive, grounded, dry humour welcome.
- Be concise but complete: two or three short paragraphs, 200–300 words total.
  No filler or repeating the question. Lead with the key number or verdict.
- Rowan has upcoming target races in context.upcoming_races and a detailed UTCT build-up plan in
  context.utct_training_plan (from UTCT training.png). When predicting race times, compare similar
  distance/vert runs in the data, note fitness trends, and reference plan targets where helpful.
  UTCT is the A-race (22 Nov 2026, ~4h15 top-10 target).

Return valid JSON (no markdown fences) with this exact shape:
{
  "answer": "two or three short paragraphs, 200–300 words total",
  "plots": [
    {
      "title": "Chart title",
      "type": "bar",
      "labels": ["label1", "label2"],
      "datasets": [
        {"label": "Distance (km)", "y_axis": "distance", "data": [1.0, 2.0], "color": "#fc4c02"},
        {"label": "Elevation (m)", "y_axis": "elevation", "data": [100.0, 200.0], "color": "#8250df"}
      ]
    }
  ]
}

Plot rules:
- Include 0–2 plots when they help (trends, comparisons, volume, vert, pace).
- "type" must be "bar", "line", or "scatter".
- All numbers in "data" must come from the training data (use precomputed series when provided).
- Keep labels short (dates as YYYY-MM-DD or Mon DD).
- Use hex colors: #fc4c02 (orange), #0550ae (blue), #2da44e (green), #8250df (purple).
- Max 2 plots per reply.
- If a chart shows both distance (km) and elevation (m), use separate datasets each with
  "y_axis": "distance" or "y_axis": "elevation". Never combine km and metres on one axis.
- For distance vs duration scatter plots, use type "scatter" with ONE dataset and points from
  series.distance_duration_points: "data": [{"x": 12.5, "y": 95.0}, ...] where x=distance_km,
  y=duration_min. Set "x_label": "distance (km)" and "y_label": "duration (min)"."""


def reload_env() -> None:
    load_dotenv(ROOT / ".env", override=True)


def is_configured() -> bool:
    reload_env()
    return bool(os.getenv("OPENAI_API_KEY", "").strip())


def _chat_temperature() -> float:
    reload_env()
    raw = os.getenv("OPENAI_CHAT_TEMPERATURE", "0.35")
    try:
        value = float(raw)
    except ValueError:
        value = 0.35
    return max(0.0, min(2.0, value))


def _openai_client():
    from openai import OpenAI

    reload_env()
    return OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


def load_utct_training_plan() -> dict[str, Any]:
    if not UTCT_TRAINING_PLAN_PATH.is_file():
        return {}
    try:
        return json.loads(UTCT_TRAINING_PLAN_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _parse_run_date(value: str | None) -> str | None:
    if not value:
        return None
    return value[:10]


def compact_run(run: dict[str, Any]) -> dict[str, Any]:
    elapsed_s = (run.get("elapsed_s") or [0])[-1] or 0
    distance_km = float(run.get("distance_km") or 0)
    pace_min_per_km = None
    if distance_km > 0 and elapsed_s > 0:
        pace_min_per_km = round(elapsed_s / 60 / distance_km, 2)

    segments = run.get("segments") or {}
    efforts = run.get("segment_efforts") or []

    return {
        "name": run.get("name"),
        "date": run.get("start_date"),
        "type": run.get("type"),
        "distance_km": distance_km,
        "elevation_gain_m": run.get("elevation_gain_m"),
        "duration_min": round(elapsed_s / 60, 1) if elapsed_s else None,
        "pace_min_per_km": pace_min_per_km,
        "average_heartrate": run.get("average_heartrate"),
        "max_heartrate": run.get("max_heartrate"),
        "climbing_segment_count": len(segments.get("climbing") or []),
        "high_speed_segment_count": len(segments.get("high_speed") or []),
        "strava_segment_effort_count": len(efforts),
        "strava_segments": [
            {
                "name": effort.get("segment_name"),
                "pace_min_per_km": effort.get("pace_min_per_km"),
                "distance_m": effort.get("distance_m"),
            }
            for effort in efforts[:10]
        ],
    }


def _weekly_series(compact_runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, float | int]] = defaultdict(
        lambda: {"distance_km": 0.0, "elevation_gain_m": 0.0, "run_count": 0}
    )

    for run in compact_runs:
        run_date = _parse_run_date(run.get("date"))
        if not run_date:
            continue
        try:
            week_key = datetime.strptime(run_date, "%Y-%m-%d").strftime("%Y-W%W")
        except ValueError:
            continue
        bucket = buckets[week_key]
        bucket["distance_km"] = round(float(bucket["distance_km"]) + float(run.get("distance_km") or 0), 2)
        bucket["elevation_gain_m"] = round(
            float(bucket["elevation_gain_m"]) + float(run.get("elevation_gain_m") or 0),
            1,
        )
        bucket["run_count"] = int(bucket["run_count"]) + 1

    return [
        {"week": week, **values}
        for week, values in sorted(buckets.items())
    ]


def _monthly_series(compact_runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, float | int]] = defaultdict(
        lambda: {"distance_km": 0.0, "elevation_gain_m": 0.0, "run_count": 0}
    )

    for run in compact_runs:
        run_date = _parse_run_date(run.get("date"))
        if not run_date:
            continue
        month_key = run_date[:7]
        bucket = buckets[month_key]
        bucket["distance_km"] = round(float(bucket["distance_km"]) + float(run.get("distance_km") or 0), 2)
        bucket["elevation_gain_m"] = round(
            float(bucket["elevation_gain_m"]) + float(run.get("elevation_gain_m") or 0),
            1,
        )
        bucket["run_count"] = int(bucket["run_count"]) + 1

    return [
        {"month": month, **values}
        for month, values in sorted(buckets.items())
    ]


def build_training_summary(
    runs: list[dict[str, Any]],
    *,
    summary: dict[str, Any] | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    compact = [compact_run(run) for run in runs]
    paces = [run["pace_min_per_km"] for run in compact if run.get("pace_min_per_km")]

    by_date = sorted(
        [
            {
                "date": _parse_run_date(run.get("date")),
                "name": run.get("name"),
                "distance_km": run.get("distance_km"),
                "elevation_gain_m": run.get("elevation_gain_m"),
                "pace_min_per_km": run.get("pace_min_per_km"),
                "duration_min": run.get("duration_min"),
            }
            for run in compact
            if _parse_run_date(run.get("date"))
        ],
        key=lambda item: item["date"] or "",
    )

    return {
        "date_range": {"start": start_date, "end": end_date},
        "summary": summary or {},
        "run_count": len(compact),
        "aggregate": {
            "total_distance_km": round(sum(run.get("distance_km") or 0 for run in compact), 2),
            "total_elevation_gain_m": round(
                sum(run.get("elevation_gain_m") or 0 for run in compact),
                1,
            ),
            "fastest_pace_min_per_km": min(paces) if paces else None,
            "slowest_pace_min_per_km": max(paces) if paces else None,
            "avg_pace_min_per_km": round(sum(paces) / len(paces), 2) if paces else None,
            "runs_with_200m_plus_vert": len(
                [run for run in compact if (run.get("elevation_gain_m") or 0) >= 200]
            ),
            "max_single_run_vert_m": max(
                (run.get("elevation_gain_m") or 0 for run in compact),
                default=0,
            ),
            "max_single_run_distance_km": max(
                (run.get("distance_km") or 0 for run in compact),
                default=0,
            ),
        },
        "series": {
            "by_date": by_date,
            "weekly": _weekly_series(compact),
            "monthly": _monthly_series(compact),
            "distance_duration_points": [
                {
                    "x": run["distance_km"],
                    "y": run["duration_min"],
                    "label": run.get("name"),
                    "date": run.get("date"),
                }
                for run in compact
                if (run.get("distance_km") or 0) > 0 and (run.get("duration_min") or 0) > 0
            ],
        },
        "runs": compact,
        "context": {
            "athlete": "Rowan Davies",
            "upcoming_races": UPCOMING_RACES,
            "focus_race": "UTCT 35 km (1,600 m climb, 22 November 2026, A-race, ~4h15 top-10 target)",
            "utct_training_plan": load_utct_training_plan(),
        },
    }


def _parse_json_response(raw: str) -> dict[str, Any]:
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    return json.loads(text)


def _parse_scatter_point(value: Any) -> dict[str, float] | None:
    if isinstance(value, dict):
        x_raw = value.get("x")
        y_raw = value.get("y")
        if x_raw is None or y_raw is None:
            return None
        try:
            return {"x": round(float(x_raw), 2), "y": round(float(y_raw), 2)}
        except (TypeError, ValueError):
            return None
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        try:
            return {"x": round(float(value[0]), 2), "y": round(float(value[1]), 2)}
        except (TypeError, ValueError):
            return None
    return None


def _parse_numeric_series(data_raw: list[Any]) -> list[float]:
    data: list[float] = []
    for value in data_raw[:40]:
        try:
            data.append(round(float(value), 2))
        except (TypeError, ValueError):
            continue
    return data


def _merge_scatter_datasets(datasets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(datasets) != 2:
        return datasets
    first, second = datasets[0], datasets[1]
    first_data = first.get("data") or []
    second_data = second.get("data") or []
    if not first_data or not isinstance(first_data[0], (int, float)):
        return datasets
    if not second_data or not isinstance(second_data[0], (int, float)):
        return datasets

    points: list[dict[str, float]] = []
    for x_val, y_val in zip(first_data, second_data):
        try:
            points.append({"x": round(float(x_val), 2), "y": round(float(y_val), 2)})
        except (TypeError, ValueError):
            continue
    if not points:
        return datasets

    return [
        {
            "label": f"{first.get('label', 'X')} vs {second.get('label', 'Y')}",
            "data": points,
            "color": first.get("color") or "#0550ae",
        }
    ]


def _scatter_point_count(plot: dict[str, Any]) -> int:
    total = 0
    for dataset in plot.get("datasets") or []:
        for point in dataset.get("data") or []:
            if isinstance(point, dict) and point.get("x") is not None and point.get("y") is not None:
                total += 1
    return total


def _build_distance_duration_scatter(compact_runs: list[dict[str, Any]]) -> dict[str, Any]:
    points = [
        {"x": run["distance_km"], "y": run["duration_min"]}
        for run in compact_runs
        if (run.get("distance_km") or 0) > 0 and (run.get("duration_min") or 0) > 0
    ]
    return {
        "title": "Distance vs duration",
        "type": "scatter",
        "labels": [],
        "x_label": "distance (km)",
        "y_label": "duration (min)",
        "datasets": [{"label": "Runs", "data": points, "color": "#0550ae"}],
    }


def _repair_coach_plots(plots: list[dict[str, Any]], compact_runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    repaired: list[dict[str, Any]] = []
    for plot in plots:
        if plot.get("type") == "scatter" and _scatter_point_count(plot) == 0:
            repaired.append(_build_distance_duration_scatter(compact_runs))
            continue
        repaired.append(plot)
    return repaired


def _sanitize_plots(plots: Any) -> list[dict[str, Any]]:
    if not isinstance(plots, list):
        return []

    allowed_types = {"bar", "line", "scatter"}
    palette = ["#fc4c02", "#0550ae", "#2da44e", "#8250df"]
    clean: list[dict[str, Any]] = []

    for index, plot in enumerate(plots[:2]):
        if not isinstance(plot, dict):
            continue

        chart_type = str(plot.get("type") or "bar").lower()
        if chart_type not in allowed_types:
            chart_type = "bar"

        labels = [str(label) for label in (plot.get("labels") or [])][:40]
        datasets_in = plot.get("datasets") or []
        datasets_out: list[dict[str, Any]] = []

        if isinstance(datasets_in, list):
            for ds_index, dataset in enumerate(datasets_in[:3]):
                if not isinstance(dataset, dict):
                    continue
                data_raw = dataset.get("data") or []
                if not isinstance(data_raw, list):
                    continue

                if chart_type == "scatter":
                    points: list[dict[str, float]] = []
                    for value in data_raw[:40]:
                        point = _parse_scatter_point(value)
                        if point:
                            points.append(point)
                    if not points:
                        continue
                    data: list[Any] = points
                else:
                    data = _parse_numeric_series(data_raw)
                    if not data:
                        continue

                color = str(dataset.get("color") or palette[ds_index % len(palette)])
                entry: dict[str, Any] = {
                    "label": str(dataset.get("label") or f"Series {ds_index + 1}"),
                    "data": data,
                    "color": color,
                }
                y_axis = str(dataset.get("y_axis") or dataset.get("yAxis") or "").lower()
                if y_axis in {"distance", "elevation", "pace"}:
                    entry["y_axis"] = y_axis
                datasets_out.append(entry)

        if chart_type == "scatter":
            datasets_out = _merge_scatter_datasets(datasets_out)

        if not labels and not datasets_out:
            continue

        if chart_type == "scatter":
            clean.append(
                {
                    "title": str(plot.get("title") or f"Chart {index + 1}"),
                    "type": chart_type,
                    "labels": [],
                    "x_label": str(plot.get("x_label") or plot.get("xLabel") or "distance (km)"),
                    "y_label": str(plot.get("y_label") or plot.get("yLabel") or "duration (min)"),
                    "datasets": datasets_out,
                }
            )
            continue

        if labels and datasets_out:
            max_len = len(labels)
            for dataset in datasets_out:
                max_len = max(max_len, len(dataset["data"]))
            labels = (labels + [""] * max_len)[:max_len]
            for dataset in datasets_out:
                dataset["data"] = (dataset["data"] + [None] * max_len)[:max_len]

        clean.append(
            {
                "title": str(plot.get("title") or f"Chart {index + 1}"),
                "type": chart_type,
                "labels": labels,
                "datasets": datasets_out,
            }
        )

    return clean


def _trim_answer(text: str, max_words: int = 300) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    trimmed = " ".join(words[:max_words])
    for sep in (". ", "! ", "? "):
        idx = trimmed.rfind(sep)
        if idx > len(trimmed) * 0.45:
            return trimmed[: idx + 1].strip()
    return trimmed.rstrip(",;:") + "…"


def ask_coach(
    question: str,
    runs: list[dict[str, Any]],
    *,
    summary: dict[str, Any] | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    brief: bool = False,
) -> dict[str, Any]:
    reload_env()
    if not is_configured():
        raise RuntimeError("OPENAI_API_KEY is not set in .env")

    question = question.strip()
    if not question:
        raise ValueError("Question is required.")
    if not runs:
        raise ValueError("No runs to analyse.")

    training = build_training_summary(
        runs,
        summary=summary,
        start_date=start_date,
        end_date=end_date,
    )

    client = _openai_client()
    model = os.getenv("OPENAI_CHAT_MODEL", "gpt-4o-mini")
    max_words = 110 if brief else 300
    max_completion_tokens = 440 if brief else 840

    user_content = (
        f"QUESTION:\n{question}\n\n"
        f"UTCT TRAINING PLAN (JSON):\n{json.dumps(training['context'].get('utct_training_plan') or {}, indent=2)}\n\n"
        f"TRAINING DATA (JSON):\n{json.dumps(training, indent=2)}"
    )
    if brief:
        user_content += (
            "\n\nBRIEF MODE: Reply in at most 3–4 short sentences (~80–110 words). "
            "Give a predicted finish time range only. Skip long training recap. "
            "Use 0 or 1 chart maximum."
        )

    response = client.chat.completions.create(
        model=model,
        temperature=_chat_temperature(),
        max_completion_tokens=max_completion_tokens,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
    )

    raw = (response.choices[0].message.content or "").strip()
    try:
        payload = _parse_json_response(raw)
    except json.JSONDecodeError as exc:
        payload = {"answer": raw, "plots": []}

    answer = _trim_answer(str(payload.get("answer") or "").strip(), max_words=max_words)
    if not answer:
        answer = _trim_answer(raw, max_words=max_words)

    plots = _sanitize_plots(payload.get("plots"))
    if brief:
        plots = plots[:1]
    plots = _repair_coach_plots(plots, training["runs"])

    return {
        "question": question,
        "answer": answer,
        "plots": plots,
        "model": model,
        "run_count": len(runs),
        "date_range": training["date_range"],
    }


def utct_opinion(
    runs: list[dict[str, Any]],
    *,
    summary: dict[str, Any] | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    return ask_coach(
        UTCT_QUESTION,
        runs,
        summary=summary,
        start_date=start_date,
        end_date=end_date,
        brief=True,
    )
