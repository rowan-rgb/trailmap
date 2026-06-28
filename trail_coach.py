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

UTCT_QUESTION = (
    "Will Rowan break top 10 at UTCT 35km (~1,900m climb) in November "
    "with a time of about 4h15m?"
)

SYSTEM_PROMPT = """You are a direct, slightly witty trail-running coach reviewing Rowan Davies's Strava training.
The user asks questions about the runs they loaded for a chosen date range.

Rules:
- Answer ONLY from the TRAINING DATA JSON. Do not invent runs, dates, or metrics.
- Say clearly if the data cannot answer the question.
- Tone: supportive, grounded, dry humour welcome.

Return valid JSON (no markdown fences) with this exact shape:
{
  "answer": "2–5 short paragraphs as plain text",
  "plots": [
    {
      "title": "Chart title",
      "type": "bar",
      "labels": ["label1", "label2"],
      "datasets": [
        {"label": "Series name", "data": [1.0, 2.0], "color": "#fc4c02"}
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
- Max 2 plots per reply."""


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
        },
        "runs": compact,
        "context": {
            "athlete": "Rowan Davies",
            "focus_race": "UTCT 35km (~1,900m climb, November, ~4h15m top-10 target)",
        },
    }


def _parse_json_response(raw: str) -> dict[str, Any]:
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    return json.loads(text)


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
                data: list[float] = []
                for value in data_raw[:40]:
                    try:
                        data.append(round(float(value), 2))
                    except (TypeError, ValueError):
                        continue
                if not data:
                    continue
                color = str(dataset.get("color") or palette[ds_index % len(palette)])
                datasets_out.append(
                    {
                        "label": str(dataset.get("label") or f"Series {ds_index + 1}"),
                        "data": data,
                        "color": color,
                    }
                )

        if not labels and not datasets_out:
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


def ask_coach(
    question: str,
    runs: list[dict[str, Any]],
    *,
    summary: dict[str, Any] | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
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

    response = client.chat.completions.create(
        model=model,
        temperature=_chat_temperature(),
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"QUESTION:\n{question}\n\n"
                    f"TRAINING DATA (JSON):\n{json.dumps(training, indent=2)}"
                ),
            },
        ],
    )

    raw = (response.choices[0].message.content or "").strip()
    try:
        payload = _parse_json_response(raw)
    except json.JSONDecodeError as exc:
        payload = {"answer": raw, "plots": []}

    answer = str(payload.get("answer") or "").strip()
    if not answer:
        answer = raw

    return {
        "question": question,
        "answer": answer,
        "plots": _sanitize_plots(payload.get("plots")),
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
    )
