/**
 * Trail pulse — canvas-drawn Strava GPS routes + timeline charts.
 * Routes use Strava activity streams (equivalent to GPX lat/lng points).
 */
(function () {
  "use strict";

  const RUN_COLORS = [
    [252, 76, 2],
    [0, 128, 255],
    [46, 184, 92],
    [155, 89, 182],
    [241, 196, 15],
    [231, 76, 60],
  ];

  const RUN_PLAYBACK_RATE = 1625;
  const GAP_PLAYBACK_RATE = 50000;
  const SLIDER_STEPS = 1000;
  const CHART_UPDATE_MS = 150;
  const FIT_PADDING_PX = 140;
  const FIT_BOUNDS_MARGIN = 0.22;
  const GRID_PRECISION = 4;
  const ROUTE_CLICK_THRESHOLD_PX = 14;
  const SEGMENT_CLICK_THRESHOLD_PX = 22;

  let deckInstance = null;
  let distanceChart = null;
  let elevGainChart = null;
  let animationTimer = null;
  let isPlaying = false;
  let rafId = null;
  let lastFrameTs = 0;
  let chartThrottleTs = 0;
  let heatmapClickBound = false;
  let timelineState = null;
  let lastZoomedRunIndex = -1;
  let mapLocked = false;
  let routeCanvas = null;
  let routeCtx = null;
  let lastSnapshot = null;
  let heatmapMode = false;
  let selectedRunIndices = [];
  let densityEdges = null;
  let runDetailMode = false;
  let runExplorerIndex = -1;
  let runElevationChart = null;
  let paceChart = null;
  let routeDetailClickBound = false;
  let loadedRunsPayload = null;
  let segmentAnalysisMode = false;
  let stravaSegments = [];
  let stravaSegmentGeometryLoading = false;
  let segmentGeometryFetchToken = 0;
  let selectedStravaSegmentId = null;
  let stravaSegmentEffortsIndex = null;
  let paceChartPoints = [];
  let segmentElevationChart = null;
  let segmentChartsHome = null;
  let appConfig = { public_demo: false, trail_map_only: false, auto_open_trail: false };

  const COACH_RACE_PRESETS = [
    {
      id: "bastille-day",
      label: "Bastille Day",
      question:
        "Predict my finish time for Bastille Day (35 km, 1,350 m climb, 11 July 2026) based on my loaded training. Give a realistic range, note gaps in the data, and include a chart if it helps.",
    },
    {
      id: "twin-peaks",
      label: "Twin Peaks",
      question:
        "Predict my finish time for Twin Peaks (30 km, 1,600 m climb, 3 October 2026) based on my loaded training. Give a realistic range, note gaps in the data, and include a chart if it helps.",
    },
    {
      id: "cape-cobra",
      label: "Cape Cobra",
      question:
        "Predict my finish time for Cape Cobra (42 km, 2,200 m climb, 24 October 2026) based on my loaded training. Give a realistic range, note gaps in the data, and include a chart if it helps.",
    },
    {
      id: "utct",
      label: "UTCT (A-race)",
      question:
        "Predict my finish time for UTCT 35 km (1,800 m climb, 22 November 2026) — my A-race. Based on loaded training, give a realistic time range and what would need to shift to hit ~4h15 top-10 pace. Include a chart if helpful.",
    },
  ];

  if (window.__TRAIL_APP_CONFIG) {
    appConfig = Object.assign(appConfig, window.__TRAIL_APP_CONFIG);
  }

  const SEGMENT_COLORS = {
    climbing: [130, 80, 223],
    high_speed: [5, 80, 174],
    high_hr: [232, 93, 117],
    high_power: [252, 76, 2],
  };

  const STRAVA_SEGMENT_COLOR = [130, 80, 220];
  const STRAVA_SEGMENT_ACTIVE_COLOR = [252, 76, 2];
  const SEGMENT_ANALYSIS_RUN_COLOR = [5, 80, 174];

  function defaultEndDate() {
    return "2026-06-30";
  }

  function defaultStartDate() {
    return "2026-06-01";
  }

  function formatTimelineDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatTimelineClock(ms) {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatChartDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatPaceAxis(value) {
    if (!Number.isFinite(value) || value <= 0) return "—";
    return value.toFixed(1) + " min/km";
  }

  function effortPaceMinPerKm(effort) {
    if (effort.pace_min_per_km != null && effort.pace_min_per_km > 0) {
      return effort.pace_min_per_km;
    }
    const distanceM = Number(effort.distance_m || 0);
    const elapsedS = Number(effort.elapsed_s || 0);
    if (distanceM > 50 && elapsedS > 0) {
      return Math.round((elapsedS / 60) / (distanceM / 1000) * 100) / 100;
    }
    return null;
  }

  function segmentIdKey(segmentId) {
    const id = Number(segmentId);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  function downsamplePath(path, maxPoints) {
    if (!path || path.length <= maxPoints) return path || [];
    const step = (path.length - 1) / (maxPoints - 1);
    const out = [];
    for (let i = 0; i < maxPoints; i += 1) {
      out.push(path[Math.round(i * step)]);
    }
    return out;
  }

  function effortPathFromRun(run, effort) {
    if (effort.path && effort.path.length >= 2) return effort.path;

    const startIdx = effort.start_index;
    const endIdx = effort.end_index;
    if (startIdx == null || endIdx == null || !run.path || run.path.length < 2) return [];

    const streamIndices = run.path_stream_indices;
    if (!streamIndices || streamIndices.length !== run.path.length) return [];

    let startPath = 0;
    let endPath = run.path.length - 1;
    for (let i = 0; i < streamIndices.length; i += 1) {
      if (streamIndices[i] >= startIdx) {
        startPath = i;
        break;
      }
    }
    for (let i = streamIndices.length - 1; i >= 0; i -= 1) {
      if (streamIndices[i] <= endIdx) {
        endPath = i;
        break;
      }
    }
    if (endPath <= startPath) return [];
    return downsamplePath(run.path.slice(startPath, endPath + 1), 80);
  }

  function buildPaceTrendLine(points) {
    if (points.length < 2) return [];
    const n = points.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    points.forEach(function (point) {
      sumX += point.tMs;
      sumY += point.paceMinPerKm;
      sumXY += point.tMs * point.paceMinPerKm;
      sumXX += point.tMs * point.tMs;
    });
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return [];

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    const times = points.map(function (point) {
      return point.tMs;
    });
    const minX = Math.min.apply(null, times);
    const maxX = Math.max.apply(null, times);
    return [
      { x: minX, y: slope * minX + intercept },
      { x: maxX, y: slope * maxX + intercept },
    ];
  }

  function formatPaceMinPerKm(paceMinPerKm) {
    if (!Number.isFinite(paceMinPerKm) || paceMinPerKm <= 0) return "—";
    const minutes = Math.floor(paceMinPerKm);
    const seconds = Math.round((paceMinPerKm - minutes) * 60);
    return minutes + ":" + String(seconds).padStart(2, "0") + " /km";
  }

  function computeRunPaceMinPerKm(run) {
    const distKm = run.distance_km || 0;
    if (distKm <= 0) return null;
    const durationS = run.elapsed_s[run.elapsed_s.length - 1] || 0;
    if (durationS <= 0) return null;
    return durationS / 60 / distKm;
  }

  function computeRangePaceMinPerKm(run, startIdx, endIdx) {
    const distM = run.distance_m[endIdx] - run.distance_m[startIdx];
    const timeS = run.elapsed_s[endIdx] - run.elapsed_s[startIdx];
    if (distM <= 10 || timeS <= 0) return null;
    return timeS / 60 / (distM / 1000);
  }

  const ANALYSIS_SEGMENT_DEFS = [
    { key: "climbing", label: "climbing", color: "#8250df" },
    { key: "high_speed", label: "high speed", color: "#0550ae" },
    { key: "high_hr", label: "high hr", color: "#e85d75", requires: "has_heartrate" },
    { key: "high_power", label: "high power", color: "#fc4c02", requires: "has_power" },
  ];

  function elevGainProfile(altitudeM) {
    const profile = [0];
    for (let i = 1; i < altitudeM.length; i += 1) {
      const delta = altitudeM[i] - altitudeM[i - 1];
      profile.push(profile[i - 1] + (delta > 0 ? delta : 0));
    }
    return profile;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function gridKey(lng, lat) {
    const scale = Math.pow(10, GRID_PRECISION);
    return Math.round(lng * scale) + "|" + Math.round(lat * scale);
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function buildRouteDensity(runs) {
    const edges = new Map();
    runs.forEach(function (run) {
      for (let i = 0; i < run.path.length - 1; i += 1) {
        const p1 = run.path[i];
        const p2 = run.path[i + 1];
        const k1 = gridKey(p1[0], p1[1]);
        const k2 = gridKey(p2[0], p2[1]);
        if (k1 === k2) continue;
        const key = k1 < k2 ? k1 + ">" + k2 : k2 + ">" + k1;
        const existing = edges.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          edges.set(key, { p1: p1, p2: p2, count: 1 });
        }
      }
    });
    return edges;
  }

  function findRunsAtCanvasPoint(x, y) {
    if (!timelineState) return [];
    const hits = [];
    timelineState.runs.forEach(function (run) {
      let best = Infinity;
      for (let i = 0; i < run.path.length - 1; i += 1) {
        const a = projectPoint(run.path[i][0], run.path[i][1]);
        const b = projectPoint(run.path[i + 1][0], run.path[i + 1][1]);
        if (!a || !b) continue;
        best = Math.min(best, distToSegment(x, y, a.x, a.y, b.x, b.y));
      }
      if (best <= ROUTE_CLICK_THRESHOLD_PX) hits.push({ run: run, dist: best });
    });
    hits.sort(function (a, b) {
      return a.dist - b.dist;
    });
    return hits.map(function (h) {
      return h.run;
    });
  }

  function getRunSegments(run) {
    return (
      run.segments || {
        climbing: [],
        high_speed: [],
        high_hr: [],
        high_power: [],
        has_heartrate: false,
        has_power: false,
        thresholds: {},
      }
    );
  }

  function segmentLegendHtml(run) {
    const segments = getRunSegments(run);
    const items = [
      { key: "climbing", label: "climbing", color: "#8250df", ranges: segments.climbing },
      { key: "high_speed", label: "high speed", color: "#0550ae", ranges: segments.high_speed },
      { key: "high_hr", label: "high hr", color: "#e85d75", ranges: segments.high_hr, available: segments.has_heartrate },
      { key: "high_power", label: "high power", color: "#fc4c02", ranges: segments.high_power, available: segments.has_power },
    ];

    return (
      '<div class="segment-legend">' +
      items
        .map(function (item) {
          const count = item.ranges.length;
          const unavailable = item.available === false;
          return (
            '<span class="segment-chip' +
            (unavailable ? " segment-chip--dim" : "") +
            '">' +
            '<span class="segment-chip__dot" style="background:' +
            item.color +
            '"></span>' +
            item.label +
            (unavailable ? " · n/a" : " · " + count) +
            "</span>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function bindRouteDetailClicks() {
    const panel = document.getElementById("strava-content");
    if (!panel || routeDetailClickBound) return;
    routeDetailClickBound = true;
    panel.addEventListener("click", function (event) {
      if (event.target.closest("#change-range-btn")) {
        resetToDateRangeForm();
        return;
      }
      if (event.target.closest("#run-explorer-back")) {
        closeRunExplorer();
        return;
      }
      if (event.target.closest(".strava-segment-back")) {
        selectedStravaSegmentId = null;
        updateSegmentAnalysisView();
        return;
      }
      if (event.target.closest(".strava-segment-card[data-strava-segment-id]")) {
        const card = event.target.closest(".strava-segment-card[data-strava-segment-id]");
        selectStravaSegment(Number(card.dataset.stravaSegmentId));
        return;
      }
      if (event.target.closest("#mode-timeline-btn")) {
        if (loadedRunsPayload) enterTimelineMode(loadedRunsPayload);
        return;
      }
      if (event.target.closest("#mode-segment-btn")) {
        if (loadedRunsPayload) enterSegmentAnalysisMode(loadedRunsPayload);
        return;
      }
      if (event.target.closest("#switch-timeline-btn")) {
        if (loadedRunsPayload) enterTimelineMode(loadedRunsPayload);
        return;
      }
      if (event.target.closest("#coach-submit-btn")) {
        submitCoachQuestion();
        return;
      }
      const raceBtn = event.target.closest(".coach-race-btn[data-race-question]");
      if (raceBtn) {
        submitCoachQuestion(raceBtn.getAttribute("data-race-question"));
        return;
      }
      const card = event.target.closest(".run-card[data-run-index]");
      if (card && timelineState && !segmentAnalysisMode) {
        openRunExplorer(Number(card.dataset.runIndex));
        return;
      }
    });
  }

  function showRunDetails(runs) {
    const detail = document.getElementById("route-detail");
    if (!detail) return;
    detail.hidden = false;
    runDetailMode = false;
    runExplorerIndex = -1;
    hideRunElevationChart();

    if (!runs.length) {
      detail.innerHTML =
        '<div class="hud-dim"># route lookup</div>' +
        '<div>Click a line on the map, then choose a run.</div>';
      return;
    }

    detail.innerHTML =
      '<div class="hud-dim"># ' +
      runs.length +
      " run" +
      (runs.length === 1 ? "" : "s") +
      " on this route · click to explore</div>" +
      runs
        .map(function (run) {
          return (
            '<div class="run-card run-card--clickable" data-run-index="' +
            run.runIndex +
            '" role="button" tabindex="0">' +
            '<div class="run-card__name">' +
            escapeHtml(run.name || "Run") +
            "</div>" +
            '<div class="hud-dim">' +
            (run.type || "Run") +
            " · " +
            run.distance_km +
            " km · +" +
            Math.round(run.totalElevGainM || run.elevation_gain_m || 0) +
            " m</div>" +
            '<div class="hud-dim">' +
            formatTimelineClock(run.startMs) +
            "</div>" +
            "</div>"
          );
        })
        .join("");
  }

  function renderRunExplorerPanel(run) {
    const detail = document.getElementById("route-detail");
    if (!detail || !run) return;
    const segments = getRunSegments(run);

    detail.innerHTML =
      '<div class="hud-dim"># run explorer</div>' +
      '<div class="run-card run-card--active">' +
      '<div class="run-card__name">' +
      escapeHtml(run.name || "Run") +
      "</div>" +
      '<div class="hud-dim">' +
      run.distance_km +
      " km · +" +
      Math.round(run.totalElevGainM || run.elevation_gain_m || 0) +
      " m · " +
      formatTimelineClock(run.startMs) +
      "</div>" +
      (run.average_heartrate
        ? '<div class="hud-dim">avg hr ' + run.average_heartrate + " bpm</div>"
        : "") +
      (run.average_watts ? '<div class="hud-dim">avg power ' + run.average_watts + " w</div>" : "") +
      "</div>" +
      segmentLegendHtml(run) +
      '<div class="hud-dim segment-thresholds">' +
      "speed ≥ " +
      (segments.thresholds.speed_mps || "?") +
      " m/s · grade ≥ " +
      (segments.thresholds.grade_pct || 4) +
      "%" +
      (segments.has_heartrate ? " · hr ≥ " + segments.thresholds.heartrate_bpm + " bpm" : "") +
      (segments.has_power ? " · power ≥ " + segments.thresholds.power_w + " w" : "") +
      "</div>" +
      '<button type="button" class="btn-secondary" id="run-explorer-back">← route runs</button>';
  }

  function hideRunElevationChart() {
    const wrap = document.getElementById("run-explorer-charts");
    if (wrap) wrap.hidden = true;
    if (runElevationChart) {
      runElevationChart.destroy();
      runElevationChart = null;
    }
  }

  function ensureRunElevationChart(run) {
    const wrap = document.getElementById("run-explorer-charts");
    const timelineCharts = document.getElementById("viz-charts");
    if (!wrap) return;

    wrap.hidden = false;
    if (timelineCharts) timelineCharts.hidden = true;

    if (runElevationChart) {
      runElevationChart.destroy();
      runElevationChart = null;
    }

    const title = document.getElementById("run-elevation-title");
    if (title) title.textContent = "run elevation · " + (run.name || "run");

    const baseData = run.distance_m.map(function (dist, index) {
      return { x: Number((dist / 1000).toFixed(3)), y: run.altitude_m[index] };
    });

    const datasets = [
      {
        label: "elevation (m)",
        data: baseData,
        borderColor: "#57606a",
        backgroundColor: "rgba(87,96,106,0.12)",
        fill: true,
        tension: 0.2,
        pointRadius: 0,
        order: 5,
      },
    ];

    const segmentDefs = [
      ["climbing", "#8250df", getRunSegments(run).climbing],
      ["high_speed", "#0550ae", getRunSegments(run).high_speed],
      ["high_power", "#fc4c02", getRunSegments(run).high_power],
      ["high_hr", "#e85d75", getRunSegments(run).high_hr],
    ];

    segmentDefs.forEach(function (entry) {
      const color = entry[1];
      const ranges = entry[2];
      ranges.forEach(function (range) {
        const slice = [];
        for (let i = range[0]; i <= range[1]; i += 1) {
          slice.push({ x: Number((run.distance_m[i] / 1000).toFixed(3)), y: run.altitude_m[i] });
        }
        if (slice.length >= 2) {
          datasets.push({
            label: entry[0],
            data: slice,
            borderColor: color,
            backgroundColor: color + "33",
            borderWidth: 3,
            fill: false,
            tension: 0.15,
            pointRadius: 0,
            order: 1,
          });
        }
      });
    });

    runElevationChart = new Chart(document.getElementById("run-elevation-chart").getContext("2d"), {
      type: "line",
      data: { datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "distance (km)", font: { family: "JetBrains Mono", size: 11 } },
            ticks: { font: { family: "JetBrains Mono", size: 10 } },
          },
          y: {
            title: { display: true, text: "elevation (m)", font: { family: "JetBrains Mono", size: 11 } },
            ticks: { font: { family: "JetBrains Mono", size: 10 } },
          },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  function drawPathRange(path, startIndex, endIndex, color, alpha, width) {
    const slice = path.slice(startIndex, endIndex + 1);
    drawPath(slice, color, alpha, width);
  }

  function drawRunExplorer(run) {
    if (!routeCtx || !routeCanvas || !run) return;
    ensureRouteCanvas();
    showRouteCanvas();
    routeCtx.clearRect(0, 0, routeCanvas.width, routeCanvas.height);

    drawPath(run.path, [120, 120, 120], 0.35, 3);

    const segments = getRunSegments(run);
    const layers = [
      ["climbing", segments.climbing, SEGMENT_COLORS.climbing, 5],
      ["high_speed", segments.high_speed, SEGMENT_COLORS.high_speed, 5],
      ["high_power", segments.high_power, SEGMENT_COLORS.high_power, 5],
      ["high_hr", segments.high_hr, SEGMENT_COLORS.high_hr, 5],
    ];

    layers.forEach(function (layer) {
      layer[1].forEach(function (range) {
        drawPathRange(run.path, range[0], range[1], layer[2], 0.92, layer[3]);
      });
    });

    drawPath(run.path, run.color || SEGMENT_COLORS.high_power, 0.18, 2);
  }

  function hideSegmentAnalysisCharts() {
    restoreSegmentChartsHome();
    const wrap = document.getElementById("segment-analysis-charts");
    if (wrap) wrap.hidden = true;
    if (paceChart) {
      paceChart.destroy();
      paceChart = null;
    }
    if (segmentElevationChart) {
      segmentElevationChart.destroy();
      segmentElevationChart = null;
    }
  }

  function mountSegmentChartsInPanel() {
    const wrap = document.getElementById("segment-analysis-charts");
    const list = document.getElementById("segment-analysis-list");
    if (!wrap || !list || !segmentAnalysisMode) return;
    if (!segmentChartsHome) {
      segmentChartsHome = wrap.parentElement;
    }
    list.insertAdjacentElement("afterend", wrap);
    wrap.classList.add("segment-analysis-charts--in-panel");
    wrap.hidden = false;
  }

  function restoreSegmentChartsHome() {
    const wrap = document.getElementById("segment-analysis-charts");
    if (!wrap || !segmentChartsHome) return;
    if (wrap.parentElement !== segmentChartsHome) {
      segmentChartsHome.appendChild(wrap);
    }
    wrap.classList.remove("segment-analysis-charts--in-panel");
  }

  function ensurePaceChart(points, title) {
    const wrap = document.getElementById("segment-analysis-charts");
    const timelineCharts = document.getElementById("viz-charts");
    if (!wrap) return;
    wrap.hidden = false;
    if (timelineCharts) timelineCharts.hidden = true;
    if (segmentAnalysisMode) mountSegmentChartsInPanel();

    const titleEl = document.getElementById("segment-pace-chart-title");
    if (titleEl) titleEl.textContent = title || "segment pace · time";

    if (paceChart) {
      paceChart.destroy();
      paceChart = null;
    }

    paceChartPoints = points || [];
    if (!paceChartPoints.length) {
      if (titleEl) titleEl.textContent = (title || "segment pace") + " · no pace data for this segment";
      wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }

    const canvas = document.getElementById("segment-pace-chart");
    if (!canvas || typeof Chart === "undefined") return;

    const trendLine = buildPaceTrendLine(paceChartPoints);

    const axisFont = { family: "JetBrains Mono", size: 10 };
    const axisColor = "#8b949e";
    const datasets = [
      {
        label: "pace (min/km)",
        data: paceChartPoints.map(function (point) {
          return { x: point.tMs, y: point.paceMinPerKm };
        }),
        borderColor: "rgba(5,80,174,0.75)",
        backgroundColor: "rgba(5,80,174,0.08)",
        borderWidth: 1.5,
        fill: true,
        tension: 0.15,
        pointRadius: paceChartPoints.length > 40 ? 0 : 4,
        pointBackgroundColor: "rgba(5, 80, 174, 0.75)",
        pointHoverRadius: 6,
        pointHitRadius: 12,
        order: 2,
      },
    ];
    if (trendLine.length === 2) {
      datasets.push({
        label: "trend",
        data: trendLine,
        borderColor: "rgba(252, 76, 2, 0.9)",
        borderWidth: 2,
        borderDash: [6, 4],
        fill: false,
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0,
        order: 1,
      });
    }

    paceChart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        onClick: function (event, elements) {
          if (!segmentAnalysisMode || !elements.length || elements[0].datasetIndex !== 0) return;
          const point = paceChartPoints[elements[0].index];
          if (!point || point.runIndex == null) return;
          const run = timelineState.runs[point.runIndex];
          if (run) flyToBounds(boundsForPath(run.path), 900, 17, 0.08);
        },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "date →", font: axisFont, color: axisColor },
            ticks: {
              font: axisFont,
              color: axisColor,
              maxTicksLimit: 6,
              callback: function (value) {
                return formatChartDate(value);
              },
            },
          },
          y: {
            reverse: true,
            title: { display: true, text: "pace (min/km)", font: axisFont, color: axisColor },
            ticks: {
              font: axisFont,
              color: axisColor,
              callback: function (value) {
                return formatPaceAxis(value);
              },
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) {
                const item = items[0];
                if (!item || !item.raw) return "";
                return formatChartDate(item.raw.x);
              },
              label: function (context) {
                if (context.datasetIndex !== 0) return null;
                const index = context.dataIndex;
                const point = paceChartPoints[index];
                if (!point) return "";
                return [
                  point.label,
                  "pace " + formatPaceAxis(point.paceMinPerKm),
                ];
              },
            },
          },
        },
      },
    });
    wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function getSegmentElevationProfile(segmentId) {
    if (!stravaSegmentEffortsIndex) return [];
    const entry = stravaSegmentEffortsIndex[segmentIdKey(segmentId)];
    if (!entry || !entry.efforts.length) return [];
    for (let i = entry.efforts.length - 1; i >= 0; i -= 1) {
      const profile = entry.efforts[i].elevation_profile;
      if (profile && profile.length >= 2) return profile;
    }
    return [];
  }

  function ensureSegmentElevationChart(segmentId, segmentName) {
    const wrap = document.getElementById("segment-analysis-charts");
    if (!wrap) return;

    const profile = getSegmentElevationProfile(segmentId);
    const titleEl = document.getElementById("segment-elevation-chart-title");
    if (titleEl) {
      titleEl.textContent = "segment elevation · " + (segmentName || "segment");
    }

    if (segmentElevationChart) {
      segmentElevationChart.destroy();
      segmentElevationChart = null;
    }

    if (!profile.length) return;

    const data = profile.map(function (point) {
      return {
        x: Number((point.distance_m / 1000).toFixed(3)),
        y: point.altitude_m,
      };
    });

    segmentElevationChart = new Chart(
      document.getElementById("segment-elevation-chart").getContext("2d"),
      {
        type: "line",
        data: {
          datasets: [
            {
              label: "elevation (m)",
              data: data,
              borderColor: "#8250df",
              backgroundColor: "rgba(130,80,223,0.12)",
              fill: true,
              tension: 0.2,
              pointRadius: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          parsing: false,
          scales: {
            x: {
              type: "linear",
              title: {
                display: true,
                text: "distance (km)",
                font: { family: "JetBrains Mono", size: 10 },
                color: "#8b949e",
              },
              ticks: { font: { family: "JetBrains Mono", size: 10 }, color: "#8b949e" },
            },
            y: {
              title: {
                display: true,
                text: "elevation (m)",
                font: { family: "JetBrains Mono", size: 10 },
                color: "#8b949e",
              },
              ticks: { font: { family: "JetBrains Mono", size: 10 }, color: "#8b949e" },
            },
          },
          plugins: { legend: { display: false } },
        },
      }
    );
  }

  function buildStravaSegmentEffortsIndex(runs) {
    const bySegment = {};
    runs.forEach(function (run) {
      (run.segment_efforts || []).forEach(function (effort) {
        const segmentId = segmentIdKey(effort.segment_id);
        if (!segmentId) return;
        if (!bySegment[segmentId]) {
          bySegment[segmentId] = {
            segment_id: segmentId,
            segment_name: effort.segment_name || "Segment",
            efforts: [],
          };
        }
        const tMs = Date.parse(effort.start_date);
        bySegment[segmentId].efforts.push({
          runIndex: run.runIndex,
          runName: run.name || "Run",
          tMs: Number.isNaN(tMs) ? run.startMs : tMs,
          paceMinPerKm: effortPaceMinPerKm(effort),
          elapsed_s: effort.elapsed_s,
          distance_m: effort.distance_m,
          pr_rank: effort.pr_rank,
          elevation_profile: effort.elevation_profile || [],
        });
      });
    });
    Object.keys(bySegment).forEach(function (key) {
      bySegment[key].efforts.sort(function (a, b) {
        return a.tMs - b.tMs;
      });
    });
    return bySegment;
  }

  function buildLocalStravaSegments(runs) {
    const byId = {};

    function upsertSegment(id, effort, path) {
      const existing = byId[id];
      const distanceKm = effort.distance_m
        ? Math.round((effort.distance_m / 1000) * 100) / 100
        : existing && existing.distance_km != null
          ? existing.distance_km
          : null;

      if (existing && existing.path.length >= 2 && path.length < existing.path.length) {
        return;
      }

      byId[id] = {
        id: id,
        name: effort.segment_name || (existing && existing.name) || "Segment",
        distance_km: distanceKm,
        path: path.length >= 2 ? path : existing && existing.path ? existing.path : [],
      };
    }

    runs.forEach(function (run) {
      (run.segment_efforts || []).forEach(function (effort) {
        const id = segmentIdKey(effort.segment_id);
        if (!id) return;
        upsertSegment(id, effort, effortPathFromRun(run, effort));
      });
    });

    return Object.keys(byId)
      .map(function (key) {
        return byId[key];
      })
      .filter(function (segment) {
        return segment.path && segment.path.length >= 2;
      });
  }

  function mergeStravaSegments(apiSegments, runs) {
    const merged = {};
    buildLocalStravaSegments(runs).forEach(function (segment) {
      merged[segmentIdKey(segment.id)] = segment;
    });
    (apiSegments || []).forEach(function (segment) {
      const id = segmentIdKey(segment.id);
      if (!id) return;
      const existing = merged[id] || {};
      merged[id] = {
        id: id,
        name: segment.name || existing.name || "Segment",
        distance_km: segment.distance_km != null ? segment.distance_km : existing.distance_km,
        avg_grade: segment.avg_grade != null ? segment.avg_grade : existing.avg_grade,
        path:
          segment.path && segment.path.length >= 2
            ? segment.path
            : existing.path || [],
      };
    });
    return Object.keys(merged)
      .map(function (key) {
        return merged[key];
      })
      .filter(function (segment) {
        return segment.path && segment.path.length >= 2;
      });
  }

  function applyCachedStravaSegments() {
    if (!timelineState) return;
    stravaSegmentEffortsIndex = buildStravaSegmentEffortsIndex(timelineState.runs);
    stravaSegments = buildLocalStravaSegments(timelineState.runs);
  }

  function segmentIdsMissingLocalPaths() {
    const withPath = {};
    stravaSegments.forEach(function (segment) {
      const id = segmentIdKey(segment.id);
      if (id) withPath[id] = true;
    });

    const missing = [];
    const seen = {};
    if (!stravaSegmentEffortsIndex) return missing;

    Object.keys(stravaSegmentEffortsIndex).forEach(function (key) {
      const id = segmentIdKey(key);
      if (!id || seen[id] || withPath[id]) return;
      seen[id] = true;
      missing.push(id);
    });
    return missing;
  }

  function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = window.setTimeout(function () {
      controller.abort();
    }, timeoutMs);
    return fetch(url, { signal: controller.signal }).finally(function () {
      window.clearTimeout(timer);
    });
  }

  function fetchSegmentGeometryInBackground() {
    if (!timelineState) return;

    const missing = segmentIdsMissingLocalPaths();
    if (!missing.length) return;

    const fetchToken = segmentGeometryFetchToken + 1;
    segmentGeometryFetchToken = fetchToken;
    stravaSegmentGeometryLoading = true;
    if (segmentAnalysisMode) updateSegmentAnalysisView();

    const batch = missing.slice(0, 40);
    const params = new URLSearchParams({ segment_ids: batch.join(",") });

    fetchWithTimeout("/api/strava/segments/from-runs?" + params.toString(), 8000)
      .then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok) {
            throw new Error(payload.message || "Failed to load segment geometry.");
          }
          return payload;
        });
      })
      .then(function (payload) {
        if (fetchToken !== segmentGeometryFetchToken || !timelineState) return;
        stravaSegments = mergeStravaSegments(payload.segments || [], timelineState.runs);
        if (segmentAnalysisMode) {
          drawSegmentAnalysisMap();
        } else if (heatmapMode) {
          drawHeatmap(timelineState.runs);
        }
      })
      .catch(function (error) {
        if (fetchToken !== segmentGeometryFetchToken) return;
        console.warn("Segment geometry fetch skipped:", error);
      })
      .finally(function () {
        if (fetchToken !== segmentGeometryFetchToken) return;
        stravaSegmentGeometryLoading = false;
        if (segmentAnalysisMode) {
          updateSegmentAnalysisView();
        }
      });
  }

  function findStravaSegmentRecord(segmentId) {
    const key = segmentIdKey(segmentId);
    return (
      stravaSegments.find(function (item) {
        return segmentIdKey(item.id) === key;
      }) || null
    );
  }

  function getStravaSegmentEfforts(segmentId) {
    if (!stravaSegmentEffortsIndex) return [];
    const entry = stravaSegmentEffortsIndex[segmentIdKey(segmentId)];
    return entry ? entry.efforts : [];
  }

  function buildStravaSegmentPacePoints(segmentId) {
    return getStravaSegmentEfforts(segmentId)
      .filter(function (effort) {
        return effort.paceMinPerKm != null && effort.paceMinPerKm > 0;
      })
      .map(function (effort) {
        return {
          tMs: effort.tMs,
          paceMinPerKm: effort.paceMinPerKm,
          label: effort.runName,
          runIndex: effort.runIndex,
        };
      });
  }

  function segmentDisplayName(segmentId) {
    const segment = findStravaSegmentRecord(segmentId);
    if (segment && segment.name) return segment.name;
    if (stravaSegmentEffortsIndex) {
      const entry = stravaSegmentEffortsIndex[segmentIdKey(segmentId)];
      if (entry && entry.segment_name) return entry.segment_name;
    }
    return "Strava segment";
  }

  function showSegmentPaceCharts(segmentId) {
    const points = buildStravaSegmentPacePoints(segmentId);
    const name = segmentDisplayName(segmentId);
    const effortCount = getStravaSegmentEfforts(segmentId).length;
    let title = "segment pace · " + name;
    if (!points.length) {
      title += effortCount ? " · no pace data" : " · no efforts";
    }
    ensurePaceChart(points, title);
    ensureSegmentElevationChart(segmentId, name);
  }

  function drawStravaSegmentOverlays() {
    if (!stravaSegments.length) return;
    stravaSegments.forEach(function (segment) {
      if (!segment.path || segment.path.length < 2) return;
      const selected = segmentIdKey(selectedStravaSegmentId) === segmentIdKey(segment.id);
      const color = selected ? STRAVA_SEGMENT_ACTIVE_COLOR : STRAVA_SEGMENT_COLOR;
      const alpha = selected ? 0.98 : heatmapMode ? 0.72 : 0.85;
      const width = selected ? 6 : heatmapMode ? 4 : 4.5;
      drawPath(segment.path, color, alpha, width);
      drawPathDirectionArrows(segment.path, color, alpha, {
        spacingPx: selected ? 48 : 56,
        arrowSize: selected ? 10 : 8,
      });
    });
  }

  function findStravaSegmentAtCanvasPoint(x, y) {
    if (!stravaSegments.length) return null;
    let best = null;
    stravaSegments.forEach(function (segment) {
      if (!segment.path || segment.path.length < 2) return;
      let bestDist = Infinity;
      for (let i = 0; i < segment.path.length - 1; i += 1) {
        const a = projectPoint(segment.path[i][0], segment.path[i][1]);
        const b = projectPoint(segment.path[i + 1][0], segment.path[i + 1][1]);
        if (!a || !b) continue;
        bestDist = Math.min(bestDist, distToSegment(x, y, a.x, a.y, b.x, b.y));
      }
      if (bestDist <= SEGMENT_CLICK_THRESHOLD_PX && (!best || bestDist < best.dist)) {
        best = { segment: segment, dist: bestDist };
      }
    });
    return best ? best.segment : null;
  }

  function getSegmentDisplayPath(segmentId) {
    const segment = findStravaSegmentRecord(segmentId);
    if (segment && segment.path && segment.path.length >= 2) {
      return segment.path;
    }
    if (!timelineState) return [];
    const efforts = getStravaSegmentEfforts(segmentId);
    for (let i = efforts.length - 1; i >= 0; i -= 1) {
      const effort = efforts[i];
      const run = timelineState.runs[effort.runIndex];
      if (!run) continue;
      const path = effortPathFromRun(run, effort);
      if (path.length >= 2) return path;
    }
    return [];
  }

  function drawSegmentAnalysisMap() {
    if (!timelineState) return;
    ensureRouteCanvas();
    if (!routeCtx || !routeCanvas) return;
    showRouteCanvas();
    routeCtx.clearRect(0, 0, routeCanvas.width, routeCanvas.height);

    if (selectedStravaSegmentId) {
      const path = getSegmentDisplayPath(selectedStravaSegmentId);
      if (path.length >= 2) {
        drawPath(path, STRAVA_SEGMENT_ACTIVE_COLOR, 0.95, 5);
        drawPathDirectionArrows(path, STRAVA_SEGMENT_ACTIVE_COLOR, 0.95, {
          spacingPx: 48,
          arrowSize: 10,
        });
      }
      return;
    }

    timelineState.runs.forEach(function (run) {
      drawPath(run.path, SEGMENT_ANALYSIS_RUN_COLOR, 0.5, 3);
    });

    drawStravaSegmentOverlays();
  }

  function renderHeatmapSegmentDetail(segmentId) {
    const segment = findStravaSegmentRecord(segmentId);
    const efforts = getStravaSegmentEfforts(segmentId);
    const points = buildStravaSegmentPacePoints(segmentId);
    return (
      '<div class="hud-dim"># segment · pace over time below</div>' +
      '<div class="run-card run-card--active">' +
      '<div class="run-card__name">' +
      escapeHtml(segmentDisplayName(segmentId)) +
      "</div>" +
      '<div class="hud-dim">' +
      (segment ? segment.distance_km + " km" : "") +
      (segment && segment.avg_grade != null ? " · " + segment.avg_grade + "% avg" : "") +
      " · " +
      efforts.length +
      " effort" +
      (efforts.length === 1 ? "" : "s") +
      (points.length ? " · " + points.length + " paced" : "") +
      "</div></div>"
    );
  }

  function segmentsForList() {
    const byId = {};

    if (stravaSegmentEffortsIndex) {
      Object.keys(stravaSegmentEffortsIndex).forEach(function (key) {
        const entry = stravaSegmentEffortsIndex[key];
        const id = segmentIdKey(key);
        if (!id) return;
        byId[id] = {
          id: id,
          name: (entry && entry.segment_name) || "Segment",
          distance_km: null,
          path: [],
        };
      });
    }

    stravaSegments.forEach(function (segment) {
      const id = segmentIdKey(segment.id);
      if (!id) return;
      byId[id] = Object.assign({}, byId[id] || {}, segment, { id: id });
    });

    return Object.keys(byId)
      .map(function (key) {
        return byId[key];
      })
      .sort(function (a, b) {
        const countA = getStravaSegmentEfforts(a.id).length;
        const countB = getStravaSegmentEfforts(b.id).length;
        if (countB !== countA) return countB - countA;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
  }

  function segmentGeometryStatusHtml() {
    if (!stravaSegmentGeometryLoading) return "";
    return '<div class="hud-dim">loading map lines…</div>';
  }

  function renderSegmentAnalysisList() {
    const listSegments = segmentsForList();

    if (!listSegments.length) {
      return '<div class="hud-dim">no Strava segments in your runs for this period</div>';
    }

    if (selectedStravaSegmentId) {
      const segment = findStravaSegmentRecord(selectedStravaSegmentId);
      const efforts = getStravaSegmentEfforts(selectedStravaSegmentId);
      return (
        '<div class="hud-dim"># selected segment · <button type="button" class="btn-secondary strava-segment-back" style="padding:1px 6px;margin-left:4px">← all segments</button></div>' +
        '<div class="run-card run-card--active">' +
        '<div class="run-card__name">' +
        escapeHtml(segmentDisplayName(selectedStravaSegmentId)) +
        "</div>" +
        '<div class="hud-dim">' +
        (segment ? segment.distance_km + " km" : "") +
        (segment && segment.avg_grade != null ? " · " + segment.avg_grade + "% avg" : "") +
        "</div>" +
        '<div class="hud-dim">' +
        efforts.length +
        " run" +
        (efforts.length === 1 ? "" : "s") +
        " · only this segment on map · pace chart below</div>" +
        "</div>" +
        '<div class="analysis-list">' +
        efforts
          .map(function (effort) {
            return (
              '<div class="run-card">' +
              '<div class="run-card__name">' +
              escapeHtml(effort.runName) +
              "</div>" +
              '<div class="hud-dim">' +
              (effort.paceMinPerKm != null
                ? "pace " + formatPaceMinPerKm(effort.paceMinPerKm)
                : "pace n/a") +
              (effort.elapsed_s ? " · " + Math.round(effort.elapsed_s / 60) + " min" : "") +
              "</div>" +
              '<div class="hud-dim">' +
              formatTimelineDate(effort.tMs) +
              (effort.pr_rank ? " · PR #" + effort.pr_rank : "") +
              "</div>" +
              "</div>"
            );
          })
          .join("") +
        "</div>"
      );
    }

    return (
      segmentGeometryStatusHtml() +
      '<div class="hud-dim"># segments · ' +
      listSegments.length +
      " · sorted by # runs · click purple segment on map or list · pace over time below</div>" +
      '<div class="analysis-list">' +
      listSegments
        .map(function (segment) {
          const entry = stravaSegmentEffortsIndex
            ? stravaSegmentEffortsIndex[segmentIdKey(segment.id)]
            : null;
          const effortCount = entry ? entry.efforts.length : 0;
          return (
            '<div class="run-card run-card--clickable strava-segment-card" data-strava-segment-id="' +
            segment.id +
            '" role="button" tabindex="0">' +
            '<div class="run-card__name">' +
            escapeHtml(segment.name || "Segment") +
            "</div>" +
            '<div class="hud-dim">' +
            (segment.distance_km != null ? segment.distance_km + " km" : "") +
            (segment.distance_km != null && segment.avg_grade != null ? " · " : "") +
            (segment.avg_grade != null ? segment.avg_grade + "% avg" : "") +
            (effortCount ? (segment.distance_km != null || segment.avg_grade != null ? " · " : "") + effortCount + " run" + (effortCount === 1 ? "" : "s") : "") +
            "</div>" +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function updateSegmentAnalysisView() {
    if (!timelineState || !segmentAnalysisMode) return;
    const list = document.getElementById("segment-analysis-list");
    const summary = document.getElementById("segment-summary");
    if (list) list.innerHTML = renderSegmentAnalysisList();
    if (summary) {
      summary.textContent =
        segmentsForList().length +
        " segments · " +
        timelineState.runs.length +
        " runs";
    }
    drawSegmentAnalysisMap();

    if (selectedStravaSegmentId) {
      showSegmentPaceCharts(selectedStravaSegmentId);
    } else {
      hideSegmentAnalysisCharts();
    }
  }

  function selectStravaSegment(segmentId) {
    selectedStravaSegmentId = segmentIdKey(segmentId);
    if (!selectedStravaSegmentId) return;

    if (segmentAnalysisMode) {
      updateSegmentAnalysisView();
    } else if (heatmapMode && timelineState) {
      selectedRunIndices = [];
      runDetailMode = false;
      runExplorerIndex = -1;
      drawHeatmap(timelineState.runs);
      const detail = document.getElementById("route-detail");
      if (detail) {
        detail.hidden = false;
        detail.innerHTML = renderHeatmapSegmentDetail(selectedStravaSegmentId);
      }
      showSegmentPaceCharts(selectedStravaSegmentId);
    }

    const segment = findStravaSegmentRecord(selectedStravaSegmentId);
    const segmentPath = getSegmentDisplayPath(selectedStravaSegmentId);
    if (segmentPath.length >= 2) {
      flyToBounds(boundsForPath(segmentPath), 700, 16, 0.1);
      window.setTimeout(function () {
        if (segmentAnalysisMode) drawSegmentAnalysisMap();
        else if (heatmapMode && timelineState) drawHeatmap(timelineState.runs);
      }, 450);
    } else if (timelineState) {
      const efforts = getStravaSegmentEfforts(selectedStravaSegmentId);
      if (efforts.length) {
        const run = timelineState.runs[efforts[efforts.length - 1].runIndex];
        if (run) flyToRun(run, 700);
      }
    }
  }

  function loadStravaSegments() {
    if (!timelineState) return;
    applyCachedStravaSegments();
    updateSegmentAnalysisView();
    fetchSegmentGeometryInBackground();
  }

  function resetLoadedRunsState() {
    loadedRunsPayload = null;
    segmentAnalysisMode = false;
    stravaSegments = [];
    stravaSegmentGeometryLoading = false;
    segmentGeometryFetchToken += 1;
    selectedStravaSegmentId = null;
    stravaSegmentEffortsIndex = null;
    paceChartPoints = [];
    hideSegmentAnalysisCharts();
    setRunAnalysisInteractive(false);
  }

  function resetToDateRangeForm() {
    stopAnimation();
    destroyCoachCharts();
    lastZoomedRunIndex = -1;
    lastSnapshot = null;
    heatmapMode = false;
    runDetailMode = false;
    runExplorerIndex = -1;
    selectedRunIndices = [];
    densityEdges = null;
    timelineState = null;
    resetLoadedRunsState();
    hideRunElevationChart();
    setHeatmapInteractive(false);
    setRunAnalysisInteractive(false);
    setMapFocusMode(true);
    hideRouteCanvas();
    document.getElementById("viz-charts").hidden = true;
    const runCharts = document.getElementById("run-explorer-charts");
    if (runCharts) runCharts.hidden = true;
    if (distanceChart) {
      distanceChart.destroy();
      distanceChart = null;
    }
    if (elevGainChart) {
      elevGainChart.destroy();
      elevGainChart = null;
    }
    document.getElementById("strava-content").innerHTML = renderDateRangeForm();
    fetchCacheStatus();
  }

  function compactRunsForCoach(runs) {
    return runs.map(function (run) {
      return {
        name: run.name,
        type: run.type,
        start_date: run.start_date,
        distance_km: run.distance_km,
        elevation_gain_m: run.elevation_gain_m,
        average_heartrate: run.average_heartrate,
        max_heartrate: run.max_heartrate,
        elapsed_s: run.elapsed_s,
        segments: run.segments,
        segment_efforts: (run.segment_efforts || []).map(function (effort) {
          return {
            segment_name: effort.segment_name,
            pace_min_per_km: effort.pace_min_per_km,
            distance_m: effort.distance_m,
          };
        }),
      };
    });
  }

  let coachCharts = [];

  function destroyCoachCharts() {
    coachCharts.forEach(function (chart) {
      chart.destroy();
    });
    coachCharts = [];
  }

  function renderCoachPlotsHtml(plots) {
    if (!plots || !plots.length) return "";
    let html = '<div class="coach-plots">';
    plots.forEach(function (plot, index) {
      html +=
        '<div class="coach-plot">' +
        '<div class="hud-dim">' +
        escapeHtml(plot.title || "Chart") +
        "</div>" +
        '<canvas id="coach-plot-' +
        index +
        '" height="140"></canvas>' +
        "</div>";
    });
    html += "</div>";
    return html;
  }

  function inferCoachDatasetAxis(dataset) {
    const explicit = String(dataset.y_axis || dataset.yAxis || "").toLowerCase();
    if (explicit === "distance" || explicit === "elevation" || explicit === "pace") {
      return explicit;
    }
    const text = String(dataset.label || "").toLowerCase();
    if (/elev|vert|gain|climb|altitude/.test(text) && !/km|pace|min/.test(text)) {
      return "elevation";
    }
    if (/distance|\bkm\b|kilomet/.test(text)) return "distance";
    if (/pace|min\/km|min-km/.test(text)) return "pace";
    return "default";
  }

  function buildCoachChartScales(datasetAxes) {
    const used = {};
    datasetAxes.forEach(function (axis) {
      used[axis] = true;
    });

    const scales = {
      x: {
        ticks: { maxRotation: 45, minRotation: 0, font: { size: 8 }, maxTicksLimit: 8 },
      },
    };

    const axisTitle = { font: { size: 8 } };
    const axisTicks = { font: { size: 8 } };

    if (used.distance && used.elevation) {
      scales.y = {
        type: "linear",
        position: "left",
        beginAtZero: true,
        title: { display: true, text: "distance (km)", ...axisTitle },
        ticks: axisTicks,
      };
      scales.y1 = {
        type: "linear",
        position: "right",
        beginAtZero: true,
        title: { display: true, text: "elevation (m)", ...axisTitle },
        ticks: axisTicks,
        grid: { drawOnChartArea: false },
      };
      return scales;
    }

    if (used.pace && (used.distance || used.elevation)) {
      scales.y = {
        type: "linear",
        position: "left",
        beginAtZero: true,
        title: {
          display: true,
          text: used.distance ? "distance (km)" : "elevation (m)",
          ...axisTitle,
        },
        ticks: axisTicks,
      };
      scales.y1 = {
        type: "linear",
        position: "right",
        reverse: true,
        beginAtZero: true,
        title: { display: true, text: "pace (min/km)", ...axisTitle },
        ticks: axisTicks,
        grid: { drawOnChartArea: false },
      };
      return scales;
    }

    scales.y = { beginAtZero: true, ticks: axisTicks };
    return scales;
  }

  function coachDatasetAxisId(axisKey, datasetAxes) {
    const used = {};
    datasetAxes.forEach(function (axis) {
      used[axis] = true;
    });
    if (used.distance && used.elevation) {
      if (axisKey === "elevation") return "y1";
      if (axisKey === "distance") return "y";
    }
    if (used.pace && (used.distance || used.elevation)) {
      if (axisKey === "pace") return "y1";
      return "y";
    }
    return "y";
  }

  function mountCoachPlots(plots) {
    destroyCoachCharts();
    if (!plots || !plots.length || typeof Chart === "undefined") return;

    plots.forEach(function (plot, index) {
      const canvas = document.getElementById("coach-plot-" + index);
      if (!canvas) return;

      const chartType = plot.type || "bar";
      const datasetAxes = (plot.datasets || []).map(inferCoachDatasetAxis);
      const scales = buildCoachChartScales(datasetAxes);
      const datasets = (plot.datasets || []).map(function (dataset, dsIndex) {
        const color = dataset.color || "#fc4c02";
        const axisKey = datasetAxes[dsIndex] || "default";
        const base = {
          label: dataset.label || "Series",
          data: dataset.data || [],
          borderColor: color,
          backgroundColor: chartType === "line" ? color + "33" : color + "bb",
          borderWidth: chartType === "scatter" ? 0 : 2,
          pointBackgroundColor: color,
          pointRadius: chartType === "scatter" ? 4 : chartType === "line" ? 2 : 0,
          tension: 0.25,
          fill: chartType === "line",
          yAxisID: coachDatasetAxisId(axisKey, datasetAxes),
        };
        return base;
      });

      const chart = new Chart(canvas.getContext("2d"), {
        type: chartType,
        data: {
          labels: plot.labels || [],
          datasets: datasets,
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: datasets.length > 1,
              labels: { boxWidth: 10, font: { size: 9 } },
            },
          },
          scales: scales,
        },
      });
      coachCharts.push(chart);
    });
  }

  function renderCoachRaceButtons() {
    return (
      '<div class="hud-dim trail-coach__race-label">predict upcoming races</div>' +
      '<div class="trail-coach__race-btns">' +
      COACH_RACE_PRESETS.map(function (race) {
        return (
          '<button type="button" class="btn-secondary coach-race-btn" data-race-id="' +
          escapeHtml(race.id) +
          '" data-race-question="' +
          escapeHtml(race.question) +
          '">' +
          escapeHtml(race.label) +
          "</button>"
        );
      }).join("") +
      "</div>"
    );
  }

  function setCoachButtonsDisabled(disabled) {
    const submitBtn = document.getElementById("coach-submit-btn");
    if (submitBtn) submitBtn.disabled = disabled;
    document.querySelectorAll(".coach-race-btn").forEach(function (btn) {
      btn.disabled = disabled;
    });
  }

  function renderCoachBlock() {
    if (appConfig.public_demo) return "";
    return (
      '<div class="utct-coach trail-coach">' +
      '<div class="hud-dim"># ask AI about these runs</div>' +
      '<textarea id="coach-question" class="trail-coach__input" rows="3" placeholder="e.g. Is vert building toward UTCT? Plot weekly elevation gain."></textarea>' +
      '<div class="trail-coach__actions">' +
      '<button type="button" class="btn-primary" id="coach-submit-btn">ask AI</button>' +
      "</div>" +
      renderCoachRaceButtons() +
      '<div class="hud-dim trail-coach__hint">answers use loaded runs only · can include simple charts</div>' +
      '<div id="coach-result" class="utct-coach__answer" hidden></div>' +
      "</div>"
    );
  }

  async function submitCoachQuestion(forcedQuestion) {
    if (!loadedRunsPayload || !loadedRunsPayload.runs.length) return;

    const inputEl = document.getElementById("coach-question");
    const resultEl = document.getElementById("coach-result");
    if (!resultEl) return;

    const question = String(forcedQuestion || (inputEl && inputEl.value) || "").trim();
    if (!question) return;
    if (inputEl && forcedQuestion) inputEl.value = forcedQuestion;

    destroyCoachCharts();
    setCoachButtonsDisabled(true);
    resultEl.hidden = false;
    resultEl.innerHTML = '<div class="hud-dim">thinking…</div>';

    try {
      const response = await fetch("/api/trail/coach/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: question,
          start_date: loadedRunsPayload.start_date,
          end_date: loadedRunsPayload.end_date,
          summary: loadedRunsPayload.summary,
          runs: compactRunsForCoach(loadedRunsPayload.runs),
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        resultEl.innerHTML =
          '<div class="hud-dim"># error</div><div>' +
          escapeHtml(data.message || "Request failed.") +
          "</div>";
        return;
      }

      resultEl.innerHTML =
        '<div class="hud-dim"># answer · ' +
        data.run_count +
        " runs · " +
        escapeHtml(data.model || "AI") +
        "</div>" +
        '<div class="utct-coach__text">' +
        escapeHtml(data.answer).replace(/\n/g, "<br>") +
        "</div>" +
        renderCoachPlotsHtml(data.plots);

      window.setTimeout(function () {
        mountCoachPlots(data.plots);
      }, 30);
    } catch (error) {
      resultEl.innerHTML =
        '<div class="hud-dim"># error</div><div>' + escapeHtml(String(error)) + "</div>";
    } finally {
      setCoachButtonsDisabled(false);
    }
  }

  function bindCoachInput() {
    const panel = document.getElementById("strava-content");
    if (!panel || panel.dataset.coachBound === "1") return;
    panel.dataset.coachBound = "1";
    panel.addEventListener("keydown", function (event) {
      if (event.target && event.target.id === "coach-question" && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitCoachQuestion();
      }
    });
  }

  function renderModePicker(payload) {
    loadedRunsPayload = payload;
    segmentAnalysisMode = false;
    hideSegmentAnalysisCharts();
    hideRouteCanvas();

    const content = document.getElementById("strava-content");
    const summary = payload.summary;
    content.innerHTML =
      '<div class="hud-ok">[ok]</div>' +
      '<div class="hud-dim">' +
      summary.run_count +
      " runs · " +
      summary.total_distance_km +
      " km · +" +
      (summary.total_elevation_gain_m || 0) +
      " m gain</div>" +
      '<div class="hud-dim mode-actions">choose view</div>' +
      '<button type="button" class="btn-primary" id="mode-timeline-btn" style="display:block;width:100%">→ timeline</button>' +
      '<button type="button" class="btn-secondary" id="mode-segment-btn" style="display:block;width:100%">→ segment analysis</button>' +
      renderCoachBlock() +
      '<button type="button" class="btn-secondary" id="change-range-btn" style="margin-top:8px">change date range</button>';
  }

  function enterTimelineMode(payload) {
    segmentAnalysisMode = false;
    stravaSegments = [];
    selectedStravaSegmentId = null;
    setRunAnalysisInteractive(false);
    hideSegmentAnalysisCharts();
    renderPlayer(payload);
  }

  async function enterSegmentAnalysisMode(payload) {
    stopAnimation();
    segmentAnalysisMode = true;
    selectedStravaSegmentId = null;
    stravaSegments = [];
    stravaSegmentEffortsIndex = null;
    heatmapMode = false;
    runDetailMode = false;
    runExplorerIndex = -1;
    hideRunElevationChart();
    setHeatmapInteractive(false);
    setRunAnalysisInteractive(true);
    ensureHeatmapClickHandler();

    try {
      timelineState = buildTimeline(payload.runs);
    } catch (error) {
      document.getElementById("strava-content").innerHTML =
        renderError(String(error)) + renderDateRangeForm();
      resetLoadedRunsState();
      return;
    }

    timelineState.summary = payload.summary;
    loadedRunsPayload = payload;

    await fetchAppConfig();

    const content = document.getElementById("strava-content");
    content.innerHTML =
      '<div class="hud-dim"># segment analysis</div>' +
      '<div id="segment-summary" class="hud-dim">' +
      timelineState.runs.length +
      " runs</div>" +
      '<div class="hud-dim" style="margin-top:8px">click purple segment on map or list · pace over time below</div>' +
      '<div id="segment-analysis-list"></div>' +
      '<button type="button" class="btn-secondary" id="switch-timeline-btn" style="display:block;width:100%;margin-top:8px">→ timeline</button>' +
      renderCoachBlock() +
      '<button type="button" class="btn-secondary" id="change-range-btn" style="margin-top:8px">change date range</button>';

    fitAllRuns(timelineState.runs, 0);
    document.getElementById("viz-charts").hidden = true;
    ensureRouteCanvas();
    loadStravaSegments();
    window.setTimeout(function () {
      if (segmentAnalysisMode && timelineState) {
        drawSegmentAnalysisMap();
        ensureMapNavigationEnabled();
      }
    }, 450);
    window.setTimeout(function () {
      ensureMapNavigationEnabled();
    }, 350);
  }

  function openRunExplorer(runIndex) {
    if (!timelineState || !heatmapMode) return;
    const run = timelineState.runs[runIndex];
    if (!run) return;

    runDetailMode = true;
    runExplorerIndex = runIndex;
    selectedRunIndices = [runIndex];
    renderRunExplorerPanel(run);
    ensureRunElevationChart(run);
    flyToRun(run, 700);
    window.setTimeout(function () {
      drawRunExplorer(run);
    }, 450);

    const label = document.getElementById("timeline-label");
    if (label) {
      label.textContent = "exploring · " + (run.name || "Run") + " · " + run.distance_km + " km";
    }
  }

  function closeRunExplorer() {
    if (!timelineState) return;
    runDetailMode = false;
    runExplorerIndex = -1;
    hideRunElevationChart();
    const timelineCharts = document.getElementById("viz-charts");
    if (timelineCharts && heatmapMode) timelineCharts.hidden = false;
    drawHeatmap(timelineState.runs);
    showRunDetails(
      selectedRunIndices
        .map(function (index) {
          return timelineState.runs[index];
        })
        .filter(Boolean)
    );
    updatePlayerUiFromSnapshot(lastSnapshot);
  }

  function setHeatmapInteractive(active) {
    const stage = document.getElementById("route-stage");
    if (stage) stage.classList.toggle("heatmap-interactive", active);
  }

  function setRunAnalysisInteractive(active) {
    const stage = document.getElementById("route-stage");
    if (stage) stage.classList.toggle("heatmap-interactive", active);
  }

  function handleHeatmapMapClick(x, y) {
    if (!heatmapMode || !timelineState || !routeCanvas) return;
    const runs = findRunsAtCanvasPoint(x, y);
    if (!runs.length) return;
    if (runDetailMode) closeRunExplorer();
    selectedStravaSegmentId = null;
    hideSegmentAnalysisCharts();
    selectedRunIndices = runs.map(function (run) {
      return run.runIndex;
    });
    showRunDetails(runs);
    drawHeatmap(timelineState.runs);
  }

  function handleRouteOverlayClick(x, y) {
    if (segmentAnalysisMode || (heatmapMode && stravaSegments.length)) {
      const segment = findStravaSegmentAtCanvasPoint(x, y);
      if (segment) {
        selectStravaSegment(segment.id);
        return;
      }
    }
    if (heatmapMode) handleHeatmapMapClick(x, y);
  }

  function ensureHeatmapClickHandler() {
    const container = document.getElementById("deck-container");
    if (container && !heatmapClickBound) {
      heatmapClickBound = true;
      container.addEventListener("click", function (event) {
        if ((!heatmapMode && !segmentAnalysisMode) || !timelineState) return;
        ensureRouteCanvas();
        if (!routeCanvas) return;
        const rect = routeCanvas.getBoundingClientRect();
        handleRouteOverlayClick(event.clientX - rect.left, event.clientY - rect.top);
      });
    }

    const map = getMapLibreMap();
    if (map && !map._trailHeatmapClickBound) {
      map._trailHeatmapClickBound = true;
      map.on("click", function (event) {
        if ((!heatmapMode && !segmentAnalysisMode) || !timelineState) return;
        ensureRouteCanvas();
        if (!routeCanvas) return;
        handleRouteOverlayClick(event.point.x, event.point.y);
      });
    }
  }

  function bindRouteCanvasEvents() {
    /* route clicks handled via deck-container so map stays pannable */
  }

  function boundsForPath(path) {
    const lngs = path.map(function (p) {
      return p[0];
    });
    const lats = path.map(function (p) {
      return p[1];
    });
    return {
      minLng: Math.min.apply(null, lngs),
      maxLng: Math.max.apply(null, lngs),
      minLat: Math.min.apply(null, lats),
      maxLat: Math.max.apply(null, lats),
    };
  }

  function boundsForRuns(runs) {
    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;

    runs.forEach(function (run) {
      run.path.forEach(function (p) {
        minLng = Math.min(minLng, p[0]);
        maxLng = Math.max(maxLng, p[0]);
        minLat = Math.min(minLat, p[1]);
        maxLat = Math.max(maxLat, p[1]);
      });
    });

    if (!Number.isFinite(minLng)) return null;
    return { minLng: minLng, maxLng: maxLng, minLat: minLat, maxLat: maxLat };
  }

  function resolveDeck() {
    if (!deckInstance) return null;
    if (typeof deckInstance.getViewports === "function") return deckInstance;
    if (deckInstance._deck && typeof deckInstance._deck.getViewports === "function") return deckInstance._deck;
    if (deckInstance.deck && typeof deckInstance.deck.getViewports === "function") return deckInstance.deck;
    return deckInstance;
  }

  function getViewport() {
    const deck = resolveDeck();
    if (!deck || typeof deck.getViewports !== "function") return null;
    const viewports = deck.getViewports();
    return viewports && viewports.length ? viewports[0] : null;
  }

  function getViewState() {
    const deck = resolveDeck();
    if (!deck) return null;
    return deck.viewState || (deck.props && deck.props.viewState) || null;
  }

  function getRouteStage() {
    let stage = document.getElementById("route-stage");
    if (!stage) {
      stage = document.createElement("div");
      stage.id = "route-stage";
      stage.hidden = true;
      document.body.appendChild(stage);
    }
    return stage;
  }

  function getMapLibreMap() {
    const deck = resolveDeck();
    if (deck) {
      if (typeof deck.getMap === "function") {
        try {
          const map = deck.getMap();
          if (map && typeof map.project === "function") return map;
        } catch (error) {
          /* ignore */
        }
      }
      if (deck._map) {
        if (typeof deck._map.project === "function") return deck._map;
        if (typeof deck._map.getMap === "function") {
          try {
            const map = deck._map.getMap();
            if (map && typeof map.project === "function") return map;
          } catch (error) {
            /* ignore */
          }
        }
      }
    }

    const mapEl =
      document.querySelector("#deck-container .maplibregl-map") ||
      document.querySelector("#deck-container .mapboxgl-map");
    if (mapEl && mapEl._map && typeof mapEl._map.project === "function") return mapEl._map;
    return null;
  }

  function projectPoint(lng, lat) {
    const map = getMapLibreMap();
    if (map) {
      try {
        const xy = map.project([lng, lat]);
        if (xy && Number.isFinite(xy.x) && Number.isFinite(xy.y)) {
          return { x: xy.x, y: xy.y };
        }
      } catch (error) {
        /* fall through */
      }
    }

    const viewport = getViewport();
    if (viewport && typeof viewport.project === "function") {
      try {
        const xy = viewport.project([lng, lat, 0]);
        if (xy && xy.length >= 2 && Number.isFinite(xy[0]) && Number.isFinite(xy[1])) {
          return { x: xy[0], y: xy[1] };
        }
      } catch (error) {
        /* ignore */
      }
    }

    return null;
  }

  function ensureRouteCanvas() {
    const stage = getRouteStage();
    if (routeCanvas) return;

    routeCanvas = document.getElementById("route-overlay");
    if (!routeCanvas) {
      routeCanvas = document.createElement("canvas");
      routeCanvas.id = "route-overlay";
      stage.appendChild(routeCanvas);
    }

    routeCanvas.style.pointerEvents = "none";
    routeCtx = routeCanvas.getContext("2d");
    if (!window._trailRouteResizeBound) {
      window._trailRouteResizeBound = true;
      window.addEventListener("resize", resizeRouteCanvas);
    }
    bindRouteCanvasEvents();
    resizeRouteCanvas();
  }

  function resizeRouteCanvas() {
    if (!routeCanvas) return;
    const stage = getRouteStage();
    const width = window.innerWidth;
    const height = window.innerHeight;
    routeCanvas.width = width;
    routeCanvas.height = height;
    routeCanvas.style.width = width + "px";
    routeCanvas.style.height = height + "px";
    stage.style.width = width + "px";
    stage.style.height = height + "px";
    if (segmentAnalysisMode && timelineState) {
      drawSegmentAnalysisMap();
    } else if (heatmapMode && timelineState) {
      drawHeatmap(timelineState.runs);
    } else if (lastSnapshot) drawRoutes(lastSnapshot);
  }

  function hideRouteCanvas() {
    const stage = getRouteStage();
    stage.hidden = true;
    if (routeCanvas) routeCanvas.hidden = true;
  }

  function showRouteCanvas() {
    ensureRouteCanvas();
    const stage = getRouteStage();
    stage.hidden = false;
    routeCanvas.hidden = false;
  }

  function drawPath(path, color, alpha, width) {
    if (!routeCtx || path.length < 2) return;

    routeCtx.beginPath();
    let started = false;

    for (let i = 0; i < path.length; i += 1) {
      const pt = projectPoint(path[i][0], path[i][1]);
      if (!pt) continue;
      if (!started) {
        routeCtx.moveTo(pt.x, pt.y);
        started = true;
      } else {
        routeCtx.lineTo(pt.x, pt.y);
      }
    }

    if (!started) return;

    routeCtx.strokeStyle = "rgba(" + color[0] + "," + color[1] + "," + color[2] + "," + alpha + ")";
    routeCtx.lineWidth = width;
    routeCtx.lineJoin = "round";
    routeCtx.lineCap = "round";
    routeCtx.stroke();
  }

  function drawArrowhead(x, y, angle, size, color, alpha) {
    if (!routeCtx) return;
    routeCtx.save();
    routeCtx.translate(x, y);
    routeCtx.rotate(angle);
    routeCtx.fillStyle = "rgba(" + color[0] + "," + color[1] + "," + color[2] + "," + alpha + ")";
    routeCtx.beginPath();
    routeCtx.moveTo(size, 0);
    routeCtx.lineTo(-size * 0.65, size * 0.55);
    routeCtx.lineTo(-size * 0.65, -size * 0.55);
    routeCtx.closePath();
    routeCtx.fill();
    routeCtx.restore();
  }

  function drawPathDirectionArrows(path, color, alpha, options) {
    if (!routeCtx || !path || path.length < 2) return;

    const spacingPx = (options && options.spacingPx) || 56;
    const arrowSize = (options && options.arrowSize) || 8;
    const minPathPx = (options && options.minPathPx) || 28;

    const projected = [];
    for (let i = 0; i < path.length; i += 1) {
      const pt = projectPoint(path[i][0], path[i][1]);
      if (pt) projected.push(pt);
    }
    if (projected.length < 2) return;

    let totalPx = 0;
    for (let i = 0; i < projected.length - 1; i += 1) {
      totalPx += Math.hypot(
        projected[i + 1].x - projected[i].x,
        projected[i + 1].y - projected[i].y
      );
    }
    if (totalPx < minPathPx) {
      const a = projected[0];
      const b = projected[projected.length - 1];
      drawArrowhead(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        Math.atan2(b.y - a.y, b.x - a.x),
        arrowSize,
        color,
        alpha
      );
      return;
    }

    let distSinceLastArrow = spacingPx * 0.35;
    for (let i = 0; i < projected.length - 1; i += 1) {
      const a = projected[i];
      const b = projected[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 0.5) continue;

      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      let segPos = 0;
      while (distSinceLastArrow + (segLen - segPos) >= spacingPx) {
        const need = spacingPx - distSinceLastArrow;
        segPos += need;
        const t = segPos / segLen;
        drawArrowhead(
          a.x + (b.x - a.x) * t,
          a.y + (b.y - a.y) * t,
          angle,
          arrowSize,
          color,
          alpha
        );
        distSinceLastArrow = 0;
      }
      distSinceLastArrow += segLen - segPos;
    }
  }

  function drawRoutes(snapshot) {
    if (!timelineState) return;
    if (segmentAnalysisMode) {
      drawSegmentAnalysisMap();
      return;
    }
    if (heatmapMode) {
      drawHeatmap(timelineState.runs);
      return;
    }

    ensureRouteCanvas();
    showRouteCanvas();
    lastSnapshot = snapshot;

    routeCtx.clearRect(0, 0, routeCanvas.width, routeCanvas.height);

    snapshot.completedTraces.forEach(function (trace) {
      drawPath(trace.path, trace.color, 0.72, 3.5);
    });

    snapshot.activeTraces.forEach(function (trace) {
      drawPath(trace.path, trace.color, 1, 5);
    });

    if (snapshot.pulse) {
      const pt = projectPoint(snapshot.pulse[0], snapshot.pulse[1]);
      if (pt) {
        const phaseBase = (performance.now() / 1000) % 1;
        for (let ring = 0; ring < 3; ring += 1) {
          const phase = (phaseBase + ring * 0.33) % 1;
          const radius = 5 + phase * 20;
          const alpha = 0.55 * (1 - phase);
          routeCtx.beginPath();
          routeCtx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
          routeCtx.strokeStyle = "rgba(252,76,2," + alpha + ")";
          routeCtx.lineWidth = 2;
          routeCtx.stroke();
        }
        routeCtx.beginPath();
        routeCtx.arc(pt.x, pt.y, 7, 0, Math.PI * 2);
        routeCtx.fillStyle = "rgba(255,255,255,0.95)";
        routeCtx.fill();
        routeCtx.lineWidth = 3;
        routeCtx.strokeStyle = "rgba(252,76,2,1)";
        routeCtx.stroke();
      }
    }
  }

  function enrichRuns(runs) {
    const enriched = runs.map(function (run, index) {
      const startMs = Date.parse(run.start_date);
      if (Number.isNaN(startMs)) {
        throw new Error("Invalid run date for: " + (run.name || run.id));
      }
      const durationMs = Math.max((run.elapsed_s[run.elapsed_s.length - 1] || 60) * 1000, 1000);
      const gainProfile = elevGainProfile(run.altitude_m || []);

      return Object.assign({}, run, {
        runIndex: index,
        color: run.color || RUN_COLORS[index % RUN_COLORS.length],
        startMs: startMs,
        endMs: startMs + durationMs,
        durationMs: durationMs,
        elevGainProfile: gainProfile,
        totalElevGainM: run.elevation_gain_m || gainProfile[gainProfile.length - 1] || 0,
      });
    });

    enriched.sort(function (a, b) {
      return a.startMs - b.startMs;
    });

    enriched.forEach(function (run, index) {
      run.runIndex = index;
    });

    return enriched;
  }

  function runProgressAtTime(run, tMs) {
    if (tMs <= run.startMs) return { index: 0, fraction: 0 };
    if (tMs >= run.endMs) return { index: run.path.length - 1, fraction: 0, complete: true };

    const elapsedTarget = (tMs - run.startMs) / 1000;
    let index = 0;
    while (index < run.elapsed_s.length - 1 && run.elapsed_s[index + 1] <= elapsedTarget) {
      index += 1;
    }
    const t0 = run.elapsed_s[index] || 0;
    const t1 = run.elapsed_s[Math.min(index + 1, run.elapsed_s.length - 1)] || t0 + 0.001;
    const fraction = t1 > t0 ? Math.min(1, Math.max(0, (elapsedTarget - t0) / (t1 - t0))) : 0;
    return { index: index, fraction: fraction };
  }

  function interpolateRunPoint(run, progress) {
    const i = progress.index;
    const p0 = run.path[i];
    const p1 = run.path[Math.min(i + 1, run.path.length - 1)];
    const f = progress.fraction;
    return [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f];
  }

  function runPartialPath(run, progress) {
    const path = run.path.slice(0, progress.index + 1);
    if (progress.fraction > 0.001 && progress.index + 1 < run.path.length) {
      path.push(interpolateRunPoint(run, progress));
    }
    return path;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function snapshotAtTime(runs, tMs) {
    const completedTraces = [];
    const activeTraces = [];
    let cumulativeDistanceKm = 0;
    let cumulativeElevGainM = 0;
    let pulse = null;
    let activeRunIndex = -1;
    let activeRunName = "";
    let runDistanceKm = 0;
    let runElevGainM = 0;

    runs.forEach(function (run) {
      const color = run.color;

      if (tMs >= run.endMs) {
        completedTraces.push({ path: run.path, color: color, name: run.name });
        cumulativeDistanceKm += run.distance_km;
        cumulativeElevGainM += run.totalElevGainM;
        return;
      }

      if (tMs >= run.startMs) {
        activeRunIndex = run.runIndex;
        activeRunName = run.name;
        const progress = runProgressAtTime(run, tMs);
        const partialPath = runPartialPath(run, progress);

        if (partialPath.length >= 2) {
          activeTraces.push({ path: partialPath, color: color, name: run.name });
        }

        const pointIndex = progress.index;
        const nextIndex = Math.min(pointIndex + 1, run.distance_m.length - 1);
        const distM = lerp(run.distance_m[pointIndex] || 0, run.distance_m[nextIndex] || 0, progress.fraction);
        const elevM = lerp(run.elevGainProfile[pointIndex] || 0, run.elevGainProfile[nextIndex] || 0, progress.fraction);
        cumulativeDistanceKm += distM / 1000;
        cumulativeElevGainM += elevM;
        runDistanceKm = distM / 1000;
        runElevGainM = elevM;
        pulse = interpolateRunPoint(run, progress);
      }
    });

    return {
      tMs: tMs,
      timelineLabel: formatTimelineClock(tMs),
      completedTraces: completedTraces,
      activeTraces: activeTraces,
      pulse: pulse,
      activeRunIndex: activeRunIndex,
      activeRunName: activeRunName,
      cumulativeDistanceKm: cumulativeDistanceKm,
      cumulativeElevGainM: cumulativeElevGainM,
      runDistanceKm: runDistanceKm,
      runElevGainM: runElevGainM,
      phase: activeRunIndex >= 0 ? "run" : tMs >= (runs.length ? runs[runs.length - 1].endMs : tMs) ? "end" : "gap",
    };
  }

  function buildTimeline(runs) {
    const enriched = enrichRuns(runs);
    if (!enriched.length) {
      const now = Date.now();
      return { runs: enriched, startMs: now, endMs: now, playbackMs: now, chartHistory: [] };
    }
    const lastRun = enriched[enriched.length - 1];
    return {
      runs: enriched,
      startMs: enriched[0].startMs,
      endMs: lastRun.endMs,
      playbackMs: enriched[0].startMs,
      chartHistory: [],
    };
  }

  function getPlaybackSpeed(tMs) {
    if (!timelineState) return RUN_PLAYBACK_RATE;
    const snap = snapshotAtTime(timelineState.runs, tMs);
    if (snap.activeRunIndex >= 0) return RUN_PLAYBACK_RATE;
    return GAP_PLAYBACK_RATE;
  }

  function activeRunAtMs(tMs) {
    if (!timelineState) return null;
    for (let i = 0; i < timelineState.runs.length; i += 1) {
      const run = timelineState.runs[i];
      if (tMs >= run.startMs && tMs < run.endMs) return run;
    }
    return null;
  }

  function nextRunAfterMs(tMs) {
    if (!timelineState) return null;
    for (let i = 0; i < timelineState.runs.length; i += 1) {
      const run = timelineState.runs[i];
      if (run.startMs > tMs) return run;
    }
    return null;
  }

  function advancePlaybackMs(currentMs, deltaMs) {
    if (!timelineState) return currentMs;
    const runs = timelineState.runs;
    if (!runs.length) return timelineState.endMs;

    let ms = currentMs;
    const activeRun = activeRunAtMs(ms);

    if (activeRun) {
      ms += deltaMs * RUN_PLAYBACK_RATE;
      if (ms < activeRun.endMs) return ms;

      const nextRun = runs[activeRun.runIndex + 1];
      if (nextRun) {
        lastZoomedRunIndex = -1;
        return nextRun.startMs;
      }
      return timelineState.endMs;
    }

    if (ms >= timelineState.endMs) return timelineState.endMs;

    const nextRun = nextRunAfterMs(ms);
    if (nextRun) {
      lastZoomedRunIndex = -1;
      return nextRun.startMs;
    }

    return timelineState.endMs;
  }

  function sliderValueFromMs(ms) {
    const span = timelineState.endMs - timelineState.startMs;
    if (span <= 0) return 0;
    return Math.round(((ms - timelineState.startMs) / span) * SLIDER_STEPS);
  }

  function isTrailPanelOpen() {
    const panel = document.getElementById("strava-panel");
    return Boolean(panel && !panel.hidden);
  }

  function updateHudFromMap(map) {
    if (!map) return;
    const center = map.getCenter();
    const hudLat = document.getElementById("hud-lat");
    const hudLng = document.getElementById("hud-lng");
    const hudZoom = document.getElementById("hud-zoom");
    const hudPitch = document.getElementById("hud-pitch");
    if (hudLat) hudLat.textContent = center.lat.toFixed(4);
    if (hudLng) hudLng.textContent = center.lng.toFixed(4);
    if (hudZoom) hudZoom.textContent = map.getZoom().toFixed(1);
    if (hudPitch) hudPitch.textContent = Math.round(map.getPitch() || 0);
  }

  function syncDeckViewFromMap() {
    const map = getMapLibreMap();
    const deck = resolveDeck();
    if (!map || !deck || typeof deck.setProps !== "function") return;
    const center = map.getCenter();
    const vs = getViewState() || {};
    deck.setProps({
      viewState: Object.assign({}, vs, {
        latitude: center.lat,
        longitude: center.lng,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
        transitionDuration: 0,
      }),
    });
  }

  let mapRedrawRaf = null;

  function bindMapViewSync() {
    const map = getMapLibreMap();
    if (!map) return false;

    if (!map._trailViewSyncBound) {
      map._trailViewSyncBound = true;
      map.on("move", function () {
        if (!timelineState && !heatmapMode && !segmentAnalysisMode) return;
        if (mapRedrawRaf) return;
        mapRedrawRaf = requestAnimationFrame(function () {
          mapRedrawRaf = null;
          if (segmentAnalysisMode && timelineState) drawSegmentAnalysisMap();
          else if (heatmapMode && timelineState) drawHeatmap(timelineState.runs);
          else if (lastSnapshot) drawRoutes(lastSnapshot);
        });
      });
      map.on("moveend", function () {
        syncDeckViewFromMap();
        updateHudFromMap(map);
        syncMapInteractionMode();
      });
    }

    return true;
  }

  function ensureMapViewSync() {
    if (bindMapViewSync()) return;
    window.setTimeout(ensureMapViewSync, 200);
  }

  function syncMapInteractionMode() {
    mapLocked = false;
    const map = getMapLibreMap();
    const useMapLibrePointer =
      (isTrailPanelOpen() || heatmapMode || segmentAnalysisMode) && Boolean(map);
    const container = document.getElementById("deck-container");
    if (container) container.style.pointerEvents = "auto";

    const mapContainer = document.querySelector(
      "#deck-container .maplibregl-map, #deck-container .mapboxgl-map"
    );
    if (mapContainer) mapContainer.style.pointerEvents = "auto";

    const host = document.getElementById("deck-container");
    if (host) {
      host.querySelectorAll("canvas").forEach(function (canvas) {
        const isMapCanvas =
          canvas.classList.contains("maplibregl-canvas") ||
          canvas.classList.contains("mapboxgl-canvas");
        if (isMapCanvas) {
          canvas.style.pointerEvents = useMapLibrePointer ? "auto" : "auto";
          return;
        }
        if (canvas.id === "route-overlay") {
          canvas.style.pointerEvents = "none";
          return;
        }
        canvas.style.pointerEvents = useMapLibrePointer ? "none" : "auto";
      });
    }

    if (routeCanvas) routeCanvas.style.pointerEvents = "none";

    if (!map || !useMapLibrePointer) return;

    ["dragPan", "scrollZoom", "touchZoomRotate", "doubleClickZoom", "keyboard", "boxZoom"].forEach(
      function (handler) {
        if (map[handler] && typeof map[handler].enable === "function") {
          map[handler].enable();
        }
      }
    );
  }

  function ensureMapNavigationEnabled() {
    syncMapInteractionMode();
    ensureMapViewSync();
  }

  function syncPulseUrl(active) {
    if (window.location.protocol === "file:") return;
    const onTrail = window.location.pathname === "/maps/trail";
    if (active && !onTrail) {
      window.history.pushState({ pulse: "trail" }, "", "/maps/trail");
    } else if (!active && onTrail) {
      window.history.replaceState({}, "", "/maps");
    }
  }

  function setMapFocusMode(active, opts) {
    opts = opts || {};
    const container = document.getElementById("deck-container");
    if (container) container.classList.toggle("trail-pulse-focus", active);
    document.body.classList.toggle("trail-pulse-focus", active);
    if (!opts.skipLayers && typeof window.updatePulseLayers === "function") {
      window.updatePulseLayers(active);
    }
    syncMapInteractionMode();
    ensureMapViewSync();
    if (!opts.skipUrl) syncPulseUrl(active);
  }

  function setMapInteractive(interactive) {
    if (interactive === false) return;
    ensureMapNavigationEnabled();
  }

  function expandBounds(bounds, marginFraction) {
    const latSpan = bounds.maxLat - bounds.minLat;
    const lngSpan = bounds.maxLng - bounds.minLng;
    const latPad = Math.max(latSpan * marginFraction, 0.003);
    const lngPad = Math.max(lngSpan * marginFraction, 0.003);
    return {
      minLng: bounds.minLng - lngPad,
      maxLng: bounds.maxLng + lngPad,
      minLat: bounds.minLat - latPad,
      maxLat: bounds.maxLat + latPad,
    };
  }

  function computeZoomForBounds(bounds, paddingPx, maxZoom) {
    const host = document.getElementById("deck-container");
    const width = host ? host.clientWidth : window.innerWidth;
    const height = host ? host.clientHeight : window.innerHeight;
    const centerLat = (bounds.minLat + bounds.maxLat) / 2;
    const latRad = (centerLat * Math.PI) / 180;
    const latSpan = Math.max(bounds.maxLat - bounds.minLat, 0.0005);
    const lngSpan = Math.max(bounds.maxLng - bounds.minLng, 0.0005);
    const effectiveW = Math.max(width - 2 * paddingPx, 256);
    const effectiveH = Math.max(height - 2 * paddingPx, 256);
    const zoomX = Math.log2(effectiveW / 512 / (lngSpan / 360 / Math.cos(latRad)));
    const zoomY = Math.log2(effectiveH / 512 / (latSpan / 180));
    return Math.min(maxZoom || 15, Math.max(9, Math.min(zoomX, zoomY)));
  }

  function flyToBounds(bounds, transitionMs, maxZoom, marginFraction) {
    if (!bounds) return;
    const margin = marginFraction !== undefined ? marginFraction : FIT_BOUNDS_MARGIN;
    const padded = expandBounds(bounds, margin);

    const map = getMapLibreMap();
    if (map && typeof map.fitBounds === "function") {
      map.fitBounds(
        [
          [padded.minLng, padded.minLat],
          [padded.maxLng, padded.maxLat],
        ],
        { padding: FIT_PADDING_PX, duration: transitionMs, maxZoom: maxZoom || 15 }
      );
      return;
    }

    const deck = resolveDeck();
    if (!deck || typeof deck.setProps !== "function") return;
    const vs = getViewState() || {};

    deck.setProps({
      viewState: Object.assign({}, vs, {
        latitude: (padded.minLat + padded.maxLat) / 2,
        longitude: (padded.minLng + padded.maxLng) / 2,
        zoom: computeZoomForBounds(padded, FIT_PADDING_PX, maxZoom),
        pitch: 0,
        bearing: 0,
        transitionDuration: transitionMs,
      }),
    });
  }

  function flyToRun(run, transitionMs) {
    if (!run || run.path.length < 2) return;
    flyToBounds(boundsForPath(run.path), transitionMs, 14, 0.26);
  }

  function fitAllRuns(runs, transitionMs) {
    flyToBounds(boundsForRuns(runs), transitionMs, 14);
  }

  function heatLineColor(t) {
    return {
      r: Math.round(30 + t * 222),
      g: Math.round(140 - t * 100),
      b: Math.round(200 - t * 190),
      a: 0.45 + t * 0.5,
    };
  }

  function drawHeatmapSegment(p1, p2, count, maxCount, highlight) {
    const pt1 = projectPoint(p1[0], p1[1]);
    const pt2 = projectPoint(p2[0], p2[1]);
    if (!pt1 || !pt2) return;

    const t = count / maxCount;
    const width = highlight ? 6 : 2 + t * 11;
    const color = highlight ? { r: 252, g: 76, b: 2, a: 0.95 } : heatLineColor(t);

    routeCtx.beginPath();
    routeCtx.moveTo(pt1.x, pt1.y);
    routeCtx.lineTo(pt2.x, pt2.y);
    routeCtx.strokeStyle = "rgba(" + color.r + "," + color.g + "," + color.b + "," + color.a + ")";
    routeCtx.lineWidth = width;
    routeCtx.lineJoin = "round";
    routeCtx.lineCap = "round";
    routeCtx.stroke();
  }

  function drawHeatmap(runs) {
    if (!routeCtx || !routeCanvas) return;
    if (runDetailMode && runExplorerIndex >= 0) {
      drawRunExplorer(timelineState.runs[runExplorerIndex]);
      return;
    }
    ensureRouteCanvas();
    showRouteCanvas();
    routeCtx.clearRect(0, 0, routeCanvas.width, routeCanvas.height);

    if (!densityEdges) densityEdges = buildRouteDensity(runs);
    const edges = Array.from(densityEdges.values());
    const maxCount = Math.max(1, edges.reduce(function (m, e) {
      return Math.max(m, e.count);
    }, 1));

    edges.forEach(function (edge) {
      drawHeatmapSegment(edge.p1, edge.p2, edge.count, maxCount, false);
    });

    if (selectedRunIndices.length) {
      selectedRunIndices.forEach(function (runIndex) {
        const run = timelineState.runs[runIndex];
        if (!run) return;
        for (let i = 0; i < run.path.length - 1; i += 1) {
          drawHeatmapSegment(run.path[i], run.path[i + 1], maxCount, maxCount, true);
        }
      });
    }

    drawStravaSegmentOverlays();
  }

  function showTimelineCompleteActions() {
    const el = document.getElementById("timeline-complete-actions");
    if (el) el.hidden = false;
  }

  function hideTimelineCompleteActions() {
    const el = document.getElementById("timeline-complete-actions");
    if (el) el.hidden = true;
  }

  function ensureStravaSegmentsReady() {
    if (!timelineState) return;
    if (!stravaSegmentEffortsIndex) {
      applyCachedStravaSegments();
    }
  }

  function enterHeatmapMode() {
    if (!timelineState || heatmapMode) return;
    heatmapMode = true;
    runDetailMode = false;
    runExplorerIndex = -1;
    hideRunElevationChart();
    selectedRunIndices = [];
    selectedStravaSegmentId = null;
    hideSegmentAnalysisCharts();
    densityEdges = buildRouteDensity(timelineState.runs);
    ensureStravaSegmentsReady();
    ensureMapNavigationEnabled();
    setHeatmapInteractive(true);
    ensureHeatmapClickHandler();
    fitAllRuns(timelineState.runs, 1200);
    showTimelineCompleteActions();
    window.setTimeout(function () {
      ensureMapNavigationEnabled();
      drawHeatmap(timelineState.runs);
      showRunDetails([]);
      const label = document.getElementById("timeline-label");
      if (label) {
        label.textContent = "heatmap · click purple segment for pace over time";
      }
    }, 500);
    window.setTimeout(ensureMapNavigationEnabled, 1400);
    window.setTimeout(ensureMapNavigationEnabled, 2500);
    updatePlayerUiFromSnapshot(lastSnapshot);
  }

  function exitHeatmapMode() {
    if (!heatmapMode) return;
    heatmapMode = false;
    runDetailMode = false;
    runExplorerIndex = -1;
    hideRunElevationChart();
    selectedRunIndices = [];
    selectedStravaSegmentId = null;
    hideSegmentAnalysisCharts();
    densityEdges = null;
    setHeatmapInteractive(false);
    hideTimelineCompleteActions();
    const detail = document.getElementById("route-detail");
    if (detail) detail.hidden = true;
    if (lastSnapshot) drawRoutes(lastSnapshot);
    updatePlayerUiFromSnapshot(lastSnapshot);
  }

  function updateMapFromSnapshot(snapshot, allowZoom) {
    drawRoutes(snapshot);

    if (allowZoom && snapshot.activeRunIndex >= 0 && snapshot.activeRunIndex !== lastZoomedRunIndex) {
      lastZoomedRunIndex = snapshot.activeRunIndex;
      flyToRun(timelineState.runs[snapshot.activeRunIndex], mapLocked ? 500 : 350);
    }
  }

  function isTimelineComplete() {
    if (!timelineState) return false;
    return timelineState.playbackMs >= timelineState.endMs;
  }

  function ensureCharts() {
    const wrap = document.getElementById("viz-charts");
    if (!wrap) return;
    wrap.hidden = false;
    if (distanceChart && elevGainChart) return;

    distanceChart = new Chart(document.getElementById("distance-chart").getContext("2d"), {
      type: "line",
      data: {
        datasets: [
          {
            label: "cumulative distance (km)",
            data: [],
            yAxisID: "y",
            borderColor: "#fc4c02",
            backgroundColor: "rgba(252,76,2,0.15)",
            fill: true,
            tension: 0.2,
            pointRadius: 0,
          },
          {
            label: "run distance (km)",
            data: [],
            yAxisID: "y1",
            borderColor: "#8250df",
            backgroundColor: "rgba(130,80,223,0.12)",
            fill: false,
            tension: 0.2,
            pointRadius: 0,
            spanGaps: false,
          },
        ],
      },
      options: chartOptions("cum dist", "run distance (km)"),
    });

    elevGainChart = new Chart(document.getElementById("elevation-chart").getContext("2d"), {
      type: "line",
      data: {
        datasets: [
          {
            label: "cumulative elevation (m)",
            data: [],
            yAxisID: "y",
            borderColor: "#0550ae",
            backgroundColor: "rgba(5,80,174,0.15)",
            fill: true,
            tension: 0.2,
            pointRadius: 0,
          },
          {
            label: "run elevation (m)",
            data: [],
            yAxisID: "y1",
            borderColor: "#2eb85c",
            backgroundColor: "rgba(46,184,92,0.12)",
            fill: false,
            tension: 0.2,
            pointRadius: 0,
            spanGaps: false,
          },
        ],
      },
      options: chartOptions("cum elev", "run elevation (m)"),
    });
  }

  function chartOptions(leftLabel, rightLabel) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      scales: {
        x: {
          type: "linear",
          reverse: false,
          title: { display: true, text: "time →", font: { family: "JetBrains Mono", size: 11 } },
          ticks: {
            maxTicksLimit: 6,
            font: { family: "JetBrains Mono", size: 10 },
            callback: function (value) {
              return formatTimelineClock(value);
            },
          },
        },
        y: {
          position: "left",
          reverse: false,
          beginAtZero: true,
          title: { display: true, text: leftLabel, font: { family: "JetBrains Mono", size: 11 } },
          ticks: { font: { family: "JetBrains Mono", size: 10 } },
        },
        y1: {
          position: "right",
          reverse: false,
          beginAtZero: true,
          grid: { drawOnChartArea: false },
          title: { display: true, text: rightLabel, font: { family: "JetBrains Mono", size: 11 } },
          ticks: { font: { family: "JetBrains Mono", size: 10 } },
        },
      },
      plugins: { legend: { display: false } },
    };
  }

  function updateChartsLive(snapshot) {
    ensureCharts();
    const history = timelineState.chartHistory;
    const last = history[history.length - 1];
    const point = {
      tMs: snapshot.tMs,
      dist: Number(snapshot.cumulativeDistanceKm.toFixed(2)),
      elev: Number(snapshot.cumulativeElevGainM.toFixed(1)),
      runDist:
        snapshot.activeRunIndex >= 0 ? Number(snapshot.runDistanceKm.toFixed(2)) : null,
      runElev: snapshot.activeRunIndex >= 0 ? Number(snapshot.runElevGainM.toFixed(1)) : null,
    };

    if (!last || snapshot.tMs - last.tMs > CHART_UPDATE_MS) {
      history.push(point);
    } else {
      history[history.length - 1] = point;
    }

    distanceChart.data.datasets[0].data = history.map(function (p) {
      return { x: p.tMs, y: p.dist };
    });
    distanceChart.data.datasets[1].data = history.map(function (p) {
      return { x: p.tMs, y: p.runDist };
    });
    elevGainChart.data.datasets[0].data = history.map(function (p) {
      return { x: p.tMs, y: p.elev };
    });
    elevGainChart.data.datasets[1].data = history.map(function (p) {
      return { x: p.tMs, y: p.runElev };
    });

    distanceChart.options.scales.x.min = timelineState.startMs;
    distanceChart.options.scales.x.max = timelineState.endMs;
    elevGainChart.options.scales.x.min = timelineState.startMs;
    elevGainChart.options.scales.x.max = timelineState.endMs;

    distanceChart.update("none");
    elevGainChart.update("none");
  }

  function updatePlayerUiFromSnapshot(snapshot) {
    if (!timelineState || !snapshot) return;
    const slider = document.getElementById("timeline-slider");
    const label = document.getElementById("timeline-label");
    const summary = document.getElementById("run-summary");

    if (slider) {
      slider.max = String(SLIDER_STEPS);
      slider.value = String(sliderValueFromMs(timelineState.playbackMs));
    }

    if (heatmapMode) {
      label.textContent = runDetailMode
        ? "exploring · " + (timelineState.runs[runExplorerIndex]?.name || "run")
        : "complete · pan map · click route";
      summary.textContent =
        timelineState.runs.length +
        " runs · " +
        timelineState.summary.total_distance_km +
        " km · +" +
        (timelineState.summary.total_elevation_gain_m || 0) +
        " m gain";
      return;
    }

    const runLabel =
      snapshot.phase === "run"
        ? snapshot.activeRunName + " · pulse"
        : snapshot.activeRunIndex >= 0
          ? snapshot.activeRunName
          : snapshot.completedTraces.length
            ? "between runs"
            : "before first run";

    label.textContent =
      snapshot.timelineLabel +
      " · " +
      runLabel +
      " · " +
      snapshot.cumulativeDistanceKm.toFixed(2) +
      " km · +" +
      Math.round(snapshot.cumulativeElevGainM) +
      " m";

    summary.textContent =
      timelineState.runs.length +
      " runs · " +
      timelineState.summary.total_distance_km +
      " km · +" +
      (timelineState.summary.total_elevation_gain_m || 0) +
      " m gain";
  }

  function setPlaybackMs(tMs, options) {
    if (!timelineState) return;
    const opts = options || {};
    const ms = Math.max(timelineState.startMs, Math.min(tMs, timelineState.endMs));
    timelineState.playbackMs = ms;
    const snapshot = snapshotAtTime(timelineState.runs, ms);
    lastSnapshot = snapshot;

    const atEnd = ms >= timelineState.endMs;
    if (atEnd && (opts.showHeatmap || heatmapMode)) {
      enterHeatmapMode();
    } else if (!atEnd && heatmapMode) {
      exitHeatmapMode();
    }

    updateMapFromSnapshot(snapshot, opts.allowZoom !== false && !heatmapMode);
    if (opts.updateCharts !== false) updateChartsLive(snapshot);
    updatePlayerUiFromSnapshot(snapshot);
  }

  function playbackLoop(ts) {
    if (!isPlaying || !timelineState) return;

    if (!lastFrameTs) lastFrameTs = ts;
    const delta = Math.min(ts - lastFrameTs, 48);
    lastFrameTs = ts;

    const nextMs = advancePlaybackMs(timelineState.playbackMs, delta);

    if (nextMs >= timelineState.endMs) {
      stopAnimation();
      const btn = document.getElementById("play-btn");
      if (btn) btn.textContent = "play";
      setPlaybackMs(timelineState.endMs, { showHeatmap: true, allowZoom: false });
      return;
    }

    const shouldUpdateChart = ts - chartThrottleTs >= CHART_UPDATE_MS;
    if (shouldUpdateChart) chartThrottleTs = ts;
    setPlaybackMs(nextMs, { allowZoom: true, updateCharts: shouldUpdateChart });

    rafId = requestAnimationFrame(playbackLoop);
  }

  function stopAnimation() {
    isPlaying = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    animationTimer = null;
    lastFrameTs = 0;
    ensureMapNavigationEnabled();
  }

  function togglePlay() {
    const btn = document.getElementById("play-btn");
    if (isPlaying) {
      stopAnimation();
      btn.textContent = "play";
      return;
    }

    if (heatmapMode) exitHeatmapMode();
    if (isTimelineComplete()) {
      timelineState.playbackMs = timelineState.startMs;
      timelineState.chartHistory = [];
      lastZoomedRunIndex = -1;
    }

    const firstRun = timelineState.runs[0];
    if (firstRun && timelineState.playbackMs < firstRun.startMs) {
      timelineState.playbackMs = firstRun.startMs;
      lastZoomedRunIndex = -1;
    }

    btn.textContent = "pause";
    isPlaying = true;
    chartThrottleTs = 0;
    lastFrameTs = 0;
    rafId = requestAnimationFrame(playbackLoop);
  }

  function renderTrailAnalysisIntro() {
    return (
      '<div class="trail-intro">' +
      '<div class="hud-dim"># rowan · trail analysis</div>' +
      '<p class="trail-intro__text">' +
      "Rowan is one of South Africa's most anonymous trail runners. However, he has goals — big goals " +
      "and big dreams. He has several upcoming races, including the hotly contested UTCT 35 km, where he " +
      "hopes to place in the top 10. Another goal is to become a trail running influencer — follow him on Insta " +
      '<a class="strava-link" href="https://instagram.com/razzie.d" target="_blank" rel="noopener noreferrer">@razzie.d</a>.' +
      "</p>" +
      '<p class="trail-intro__text">' +
      "This web-based tool reflects his commitment to trail running and data-driven design. Please explore " +
      "Rowan's trail running history through data visualisation and segment analysis, as well as an AI coach " +
      "and prediction agent to help Rowan achieve his ambitions of placing at UTCT, receiving sponsorship, " +
      "and becoming South Africa's most well-regarded trail running authority." +
      "</p>" +
      '<p class="trail-intro__cta">Select a date range below to get started.</p>' +
      "</div>"
    );
  }

  let stravaCacheStatus = null;

  async function fetchAppConfig() {
    try {
      const payload = await (await fetch("/api/config")).json();
      appConfig = Object.assign(appConfig, payload);
    } catch (error) {
      /* keep build-time or default config */
    }
    return appConfig;
  }

  async function fetchCacheStatus() {
    try {
      stravaCacheStatus = await (await fetch("/api/strava/cache/status")).json();
    } catch (error) {
      stravaCacheStatus = null;
    }
    return stravaCacheStatus;
  }

  function renderCacheStatusBlock() {
    const status = stravaCacheStatus;
    if (!status || !status.run_count) {
      return (
        '<div id="cache-status" class="cache-status hud-dim">' +
        "# local store · empty" +
        "</div>"
      );
    }

    let line = "# local store · " + status.run_count + " runs";
    if (status.min_date && status.max_date) {
      line += " · " + status.min_date + " → " + status.max_date;
    }
    return '<div id="cache-status" class="cache-status hud-dim">' + line + "</div>";
  }

  async function showDateRangeForm() {
    await fetchAppConfig();
    await fetchCacheStatus();
    const content = document.getElementById("strava-content");
    if (content) content.innerHTML = renderDateRangeForm();
  }

  async function syncStravaCache() {
    const content = document.getElementById("strava-content");
    if (!content) return;

    const auth = await (await fetch("/api/strava/status")).json();
    if (auth.setup_error) {
      content.innerHTML = renderSetupError(auth.setup_error) + renderDateRangeForm();
      return;
    }
    if (!auth.connected) {
      content.innerHTML =
        '<div class="hud-dim"># not authenticated</div><div style="margin-top:10px"><a class="strava-link" href="/auth/strava">→ connect strava</a></div>' +
        renderDateRangeForm();
      return;
    }
    if (!auth.activity_access) {
      content.innerHTML =
        renderConnectStrava("Re-authorize Strava to read activities.") + renderDateRangeForm();
      return;
    }

    stopAnimation();
    let prepare = true;
    let runCount = (stravaCacheStatus && stravaCacheStatus.run_count) || 0;

    content.innerHTML =
      renderTrailAnalysisIntro() +
      renderCacheStatusBlock() +
      '<div class="hud-dim" style="margin-top:8px"># syncing latest</div>' +
      '<div id="sync-progress">checking Strava for new runs…</div>' +
      '<div class="hud-dim" style="margin-top:8px">only downloads runs not already stored locally</div>';

    function progressEl() {
      return document.getElementById("sync-progress");
    }

    try {
      while (true) {
        const response = await fetch("/api/strava/cache/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prepare: prepare,
            batch_size: 3,
          }),
        });
        prepare = false;
        const data = await response.json();

        if (!response.ok) {
          if (response.status === 429 || data.rate_limited) {
            content.innerHTML =
              renderError(
                data.message ||
                  "Strava rate limit hit. Wait ~15 minutes, then sync again — progress is saved."
              ) + renderDateRangeForm();
            await fetchCacheStatus();
            return;
          }
          content.innerHTML = renderError(data.message || "Sync failed.") + renderDateRangeForm();
          await fetchCacheStatus();
          return;
        }

        runCount = data.run_count || runCount;
        const el = progressEl();
        if (el) {
          if (data.complete) {
            el.textContent = runCount + " runs stored · up to date";
          } else {
            el.textContent =
              runCount +
              " runs stored · " +
              (data.pending_count || 0) +
              " new remaining";
          }
        }

        if (data.complete) break;

        await new Promise(function (resolve) {
          window.setTimeout(resolve, 2000);
        });
      }

      await showDateRangeForm();
    } catch (error) {
      content.innerHTML = renderError(String(error)) + renderDateRangeForm();
      await fetchCacheStatus();
    }
  }

  function renderDateRangeForm() {
    const syncBlock = appConfig.public_demo
      ? '<div class="hud-dim" style="margin-top:8px">public demo · cached runs only</div>'
      : '<button type="button" class="btn-secondary" id="sync-strava-btn" style="display:block;width:100%;margin-top:8px">sync latest from strava</button>' +
        '<div class="hud-dim" style="margin-top:8px">loads from local store · sync fetches only missing runs</div>';

    return (
      renderTrailAnalysisIntro() +
      renderCacheStatusBlock() +
      syncBlock +
      '<div class="hud-dim" style="margin-top:10px"># select date range</div>' +
      '<div class="range-row"><label class="hud-dim">from</label><input type="date" id="range-start" value="' +
      defaultStartDate() +
      '" /></div>' +
      '<div class="range-row"><label class="hud-dim">to</label><input type="date" id="range-end" value="' +
      defaultEndDate() +
      '" /></div>' +
      '<div class="range-actions"><button type="button" class="btn-primary" id="load-runs-btn">load runs</button></div>'
    );
  }

  function renderConnectStrava(message) {
    return (
      '<div class="hud-dim"># authorization required</div><div>' +
      message +
      '</div><div style="margin-top:10px"><a class="strava-link" href="/auth/strava/reconnect">→ re-authorize strava</a></div>'
    );
  }

  function renderSetupError(message) {
    return '<div class="hud-dim"># setup incomplete</div><div>' + message + "</div>";
  }

  function renderError(message) {
    return '<div class="hud-dim"># error</div><div>' + message + "</div>";
  }

  async function renderPlayer(payload) {
    await fetchAppConfig();
    const content = document.getElementById("strava-content");
    segmentAnalysisMode = false;
    hideSegmentAnalysisCharts();
    loadedRunsPayload = payload;
    try {
      timelineState = buildTimeline(payload.runs);
    } catch (error) {
      content.innerHTML = renderError(String(error)) + renderDateRangeForm();
      return;
    }

    timelineState.summary = payload.summary;
    stravaSegments = [];
    selectedStravaSegmentId = null;
    applyCachedStravaSegments();
    lastZoomedRunIndex = -1;
    lastSnapshot = null;
    heatmapMode = false;
    runDetailMode = false;
    runExplorerIndex = -1;
    selectedRunIndices = [];
    densityEdges = null;
    hideRunElevationChart();
    setHeatmapInteractive(false);
    hideTimelineCompleteActions();

    content.innerHTML =
      '<div class="hud-ok">[ok]</div>' +
      '<div id="run-summary" class="hud-dim"></div>' +
      '<div class="player-controls">' +
      '<button type="button" class="btn-secondary" id="play-btn">play</button>' +
      '<input type="range" id="timeline-slider" min="0" max="100" value="0" step="1" />' +
      '<div class="timeline-meta">' +
      '<span id="timeline-start-label"></span>' +
      '<span id="timeline-end-label"></span>' +
      "</div>" +
      '<div id="timeline-label" class="hud-val"></div>' +
      "</div>" +
      '<div id="route-detail" class="route-detail" hidden></div>' +
      '<div id="timeline-complete-actions" hidden>' +
      '<button type="button" class="btn-primary" id="mode-segment-btn" style="display:block;width:100%;margin-top:8px">→ segment analysis</button>' +
      "</div>" +
      renderCoachBlock() +
      '<button type="button" class="btn-secondary" id="change-range-btn">change date range</button>';

    document.getElementById("timeline-start-label").textContent = formatTimelineDate(timelineState.startMs);
    document.getElementById("timeline-end-label").textContent = formatTimelineDate(timelineState.endMs);

    fitAllRuns(timelineState.runs, 0);
    window.setTimeout(function () {
      if (timelineState.runs.length > 0) {
        lastZoomedRunIndex = 0;
        flyToRun(timelineState.runs[0], 600);
      }
      setPlaybackMs(timelineState.startMs, { allowZoom: false });
    }, 400);

    document.getElementById("play-btn").addEventListener("click", togglePlay);
    document.getElementById("timeline-slider").addEventListener("input", function (event) {
      stopAnimation();
      document.getElementById("play-btn").textContent = "play";
      const t = Number(event.target.value) / SLIDER_STEPS;
      const ms = timelineState.startMs + t * (timelineState.endMs - timelineState.startMs);
      lastZoomedRunIndex = -1;
      setPlaybackMs(ms, { allowZoom: true, showHeatmap: ms >= timelineState.endMs });
    });
    document.getElementById("change-range-btn").addEventListener("click", function () {
      resetToDateRangeForm();
    });
  }

  async function loadRuns(startDate, endDate) {
    const content = document.getElementById("strava-content");
    if (!startDate || !endDate) {
      content.innerHTML = renderError("Choose both start and end dates.") + renderDateRangeForm();
      return;
    }

    content.innerHTML =
      '<div class="hud-dim"># loading</div>' +
      "<div>reading runs from local store…</div>";

    try {
      const response = await fetch(
        "/api/strava/runs/timeline?start=" + encodeURIComponent(startDate) + "&end=" + encodeURIComponent(endDate)
      );
      const data = await response.json();

      if (!response.ok) {
        if (response.status === 404 && data.needs_sync) {
          await fetchCacheStatus();
          content.innerHTML =
            renderError(data.message || "No runs stored locally yet. Use sync latest from Strava.") +
            renderDateRangeForm();
          return;
        }
        if (response.status === 403 && data.activity_access === false) {
          content.innerHTML = renderConnectStrava(data.message || "Re-authorize Strava.");
          return;
        }
        content.innerHTML = renderError(data.message || "Could not load runs.") + renderDateRangeForm();
        return;
      }

      if (!data.runs || data.runs.length === 0) {
        content.innerHTML =
          '<div class="hud-dim"># no runs found</div><div>No runs in this date range.</div>' +
          '<button type="button" class="btn-secondary" id="change-range-btn">change date range</button>';
        document.getElementById("change-range-btn").addEventListener("click", function () {
          content.innerHTML = renderDateRangeForm();
        });
        return;
      }

      await fetchAppConfig();
      renderModePicker(data);
    } catch (error) {
      content.innerHTML = renderError(String(error)) + renderDateRangeForm();
    }
  }

  function bindLoadRuns() {
    const root = document.getElementById("strava-content");
    if (!root || root.dataset.loadBound === "1") return;
    root.dataset.loadBound = "1";
    root.addEventListener("click", function (event) {
      if (event.target.closest("#sync-strava-btn")) {
        event.preventDefault();
        syncStravaCache();
        return;
      }
      const btn = event.target.closest("#load-runs-btn");
      if (!btn) return;
      event.preventDefault();
      stopAnimation();
      const startEl = document.getElementById("range-start");
      const endEl = document.getElementById("range-end");
      loadRuns(startEl ? startEl.value : "", endEl ? endEl.value : "");
    });
  }

  async function openTrailPulsePanel(opts) {
    opts = opts || {};
    if (window.enterTrailAnalysisMode) {
      window.enterTrailAnalysisMode();
    }
    const panel = document.getElementById("strava-panel");
    const content = document.getElementById("strava-content");
    document.getElementById("pulse-panel-title").textContent = "Rowan's trail analysis";
    panel.hidden = false;
    setMapFocusMode(true, Object.assign({ skipLayers: true }, opts));
    ensureMapNavigationEnabled();

    if (window.location.protocol === "file:") {
      content.innerHTML = renderError("Open http://localhost:5000/maps via server.py");
      return;
    }

    await showDateRangeForm();
  }

  window.TrailPulseViz = {
    init: function (deck) {
      deckInstance = deck;
      bindLoadRuns();
      bindCoachInput();
      bindRouteDetailClicks();
      ensureRouteCanvas();
      ensureHeatmapClickHandler();
      ensureMapNavigationEnabled();
      window.setTimeout(ensureMapNavigationEnabled, 600);
    },
    open: openTrailPulsePanel,
    stop: stopAnimation,
    setFocus: setMapFocusMode,
    redrawRoutes: function () {
      if (segmentAnalysisMode && timelineState) {
        drawSegmentAnalysisMap();
      } else if (runDetailMode && timelineState && runExplorerIndex >= 0) {
        drawRunExplorer(timelineState.runs[runExplorerIndex]);
      } else if (heatmapMode && timelineState) {
        drawHeatmap(timelineState.runs);
      } else if (lastSnapshot) {
        drawRoutes(lastSnapshot);
      }
    },
  };
})();
