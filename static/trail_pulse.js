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
  let routeDetailClickBound = false;

  const SEGMENT_COLORS = {
    climbing: [130, 80, 223],
    high_speed: [5, 80, 174],
    high_hr: [232, 93, 117],
    high_power: [252, 76, 2],
  };

  function defaultEndDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function defaultStartDate() {
    const date = new Date();
    date.setMonth(date.getMonth() - 6);
    return date.toISOString().slice(0, 10);
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
      if (event.target.closest("#run-explorer-back")) {
        closeRunExplorer();
        return;
      }
      const card = event.target.closest(".run-card[data-run-index]");
      if (!card || !timelineState) return;
      openRunExplorer(Number(card.dataset.runIndex));
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

  function handleHeatmapMapClick(x, y) {
    if (!heatmapMode || !timelineState || !routeCanvas) return;
    const runs = findRunsAtCanvasPoint(x, y);
    if (!runs.length) return;
    if (runDetailMode) closeRunExplorer();
    selectedRunIndices = runs.map(function (run) {
      return run.runIndex;
    });
    showRunDetails(runs);
    drawHeatmap(timelineState.runs);
  }

  function ensureHeatmapClickHandler() {
    const container = document.getElementById("deck-container");
    if (container && !heatmapClickBound) {
      heatmapClickBound = true;
      container.addEventListener("click", function (event) {
        if (!heatmapMode || !timelineState || !routeCanvas) return;
        const rect = routeCanvas.getBoundingClientRect();
        handleHeatmapMapClick(event.clientX - rect.left, event.clientY - rect.top);
      });
    }

    const map = getMapLibreMap();
    if (map && !map._trailHeatmapClickBound) {
      map._trailHeatmapClickBound = true;
      map.on("click", function (event) {
        if (!heatmapMode || !timelineState || !routeCanvas) return;
        handleHeatmapMapClick(event.point.x, event.point.y);
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
    if (heatmapMode && timelineState) drawHeatmap(timelineState.runs);
    else if (lastSnapshot) drawRoutes(lastSnapshot);
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

  function drawRoutes(snapshot) {
    if (!timelineState) return;
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
        if (!timelineState && !heatmapMode) return;
        if (mapRedrawRaf) return;
        mapRedrawRaf = requestAnimationFrame(function () {
          mapRedrawRaf = null;
          if (heatmapMode && timelineState) drawHeatmap(timelineState.runs);
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
    const useMapLibrePointer = (isTrailPanelOpen() || heatmapMode) && Boolean(map);
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

  function setMapFocusMode(active) {
    const container = document.getElementById("deck-container");
    if (container) container.classList.toggle("trail-pulse-focus", active);
    document.body.classList.toggle("trail-pulse-focus", active);
    if (typeof window.updatePulseLayers === "function") {
      window.updatePulseLayers(active);
    }
    syncMapInteractionMode();
    ensureMapViewSync();
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
  }

  function enterHeatmapMode() {
    if (!timelineState || heatmapMode) return;
    heatmapMode = true;
    runDetailMode = false;
    runExplorerIndex = -1;
    hideRunElevationChart();
    selectedRunIndices = [];
    densityEdges = buildRouteDensity(timelineState.runs);
    ensureMapNavigationEnabled();
    setHeatmapInteractive(true);
    ensureHeatmapClickHandler();
    fitAllRuns(timelineState.runs, 1200);
    window.setTimeout(function () {
      ensureMapNavigationEnabled();
      drawHeatmap(timelineState.runs);
      showRunDetails([]);
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
    densityEdges = null;
    setHeatmapInteractive(false);
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

  function renderDateRangeForm() {
    return (
      '<div class="hud-dim"># select time range</div>' +
      '<div class="range-row"><label class="hud-dim">from</label><input type="date" id="range-start" value="' +
      defaultStartDate() +
      '" /></div>' +
      '<div class="range-row"><label class="hud-dim">to</label><input type="date" id="range-end" value="' +
      defaultEndDate() +
      '" /></div>' +
      '<div class="range-actions"><button type="button" class="btn-primary" id="load-runs-btn">load runs</button></div>' +
      '<div class="hud-dim" style="margin-top:8px">GPS routes from Strava streams</div>'
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

  function renderPlayer(payload) {
    const content = document.getElementById("strava-content");
    try {
      timelineState = buildTimeline(payload.runs);
    } catch (error) {
      content.innerHTML = renderError(String(error)) + renderDateRangeForm();
      return;
    }

    timelineState.summary = payload.summary;
    lastZoomedRunIndex = -1;
    lastSnapshot = null;
    heatmapMode = false;
    runDetailMode = false;
    runExplorerIndex = -1;
    selectedRunIndices = [];
    densityEdges = null;
    hideRunElevationChart();
    setHeatmapInteractive(false);

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
      stopAnimation();
      lastZoomedRunIndex = -1;
      lastSnapshot = null;
      heatmapMode = false;
      runDetailMode = false;
      runExplorerIndex = -1;
      selectedRunIndices = [];
      densityEdges = null;
      hideRunElevationChart();
      setHeatmapInteractive(false);
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
      content.innerHTML = renderDateRangeForm();
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
      "<div>fetching GPS streams from strava...</div>" +
      '<div class="hud-dim" style="margin-top:8px">this can take 20–40s for many runs</div>';

    try {
      const response = await fetch(
        "/api/strava/runs/timeline?start=" + encodeURIComponent(startDate) + "&end=" + encodeURIComponent(endDate)
      );
      const data = await response.json();

      if (!response.ok) {
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

      renderPlayer(data);
    } catch (error) {
      content.innerHTML = renderError(String(error)) + renderDateRangeForm();
    }
  }

  function bindLoadRuns() {
    const root = document.getElementById("strava-content");
    if (!root || root.dataset.loadBound === "1") return;
    root.dataset.loadBound = "1";
    root.addEventListener("click", function (event) {
      const btn = event.target.closest("#load-runs-btn");
      if (!btn) return;
      event.preventDefault();
      stopAnimation();
      const startEl = document.getElementById("range-start");
      const endEl = document.getElementById("range-end");
      loadRuns(startEl ? startEl.value : "", endEl ? endEl.value : "");
    });
  }

  async function openTrailPulsePanel() {
    const panel = document.getElementById("strava-panel");
    const content = document.getElementById("strava-content");
    document.getElementById("pulse-panel-title").textContent = "strava trail pulse";
    panel.hidden = false;
    setMapFocusMode(true);
    ensureMapNavigationEnabled();

    if (window.location.protocol === "file:") {
      content.innerHTML = renderError("Open http://localhost:5000 via server.py");
      return;
    }

    const status = await (await fetch("/api/strava/status")).json();
    if (status.setup_error) {
      content.innerHTML = renderSetupError(status.setup_error);
      return;
    }
    if (!status.connected) {
      content.innerHTML =
        '<div class="hud-dim"># not authenticated</div><div style="margin-top:10px"><a class="strava-link" href="/auth/strava">→ connect strava</a></div>';
      return;
    }
    if (!status.activity_access) {
      content.innerHTML = renderConnectStrava(
        "Connected as " + (status.athlete && status.athlete.firstname ? status.athlete.firstname : "athlete") +
          ", but activity access is missing."
      );
      return;
    }

    content.innerHTML = renderDateRangeForm();
  }

  window.TrailPulseViz = {
    init: function (deck) {
      deckInstance = deck;
      bindLoadRuns();
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
      if (runDetailMode && timelineState && runExplorerIndex >= 0) {
        drawRunExplorer(timelineState.runs[runExplorerIndex]);
      } else if (heatmapMode && timelineState) {
        drawHeatmap(timelineState.runs);
      } else if (lastSnapshot) {
        drawRoutes(lastSnapshot);
      }
    },
  };
})();
