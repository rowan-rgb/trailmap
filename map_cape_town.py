"""Interactive Cape Town map — trail topo view with trail pulse + Strava timeline."""

from __future__ import annotations

import re
from pathlib import Path

import pydeck as pdk

CITY_MOBILITY_PULSE = {
    "name": "city mobility pulse",
    "latitude": -33.9249,
    "longitude": 18.4241,
    "color": [5, 80, 174],
    "glow": [5, 80, 174, 60],
}

TRAIL_PULSE = {
    "name": "trail analysis",
    "latitude": -33.9628,
    "longitude": 18.4098,
    "color": [217, 119, 6],
    "glow": [217, 119, 6, 60],
}

PULSES = [CITY_MOBILITY_PULSE, TRAIL_PULSE]
TRAIL_BASEMAP = "/static/trail_basemap.json"

MAP_CENTER_LAT = -33.944
MAP_CENTER_LNG = 18.417
ZOOM = 12.2
PITCH = 0
BEARING = 0

HUD_HEAD = """
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="/static/trail_pulse.js?v=57"></script>
<style>
  :root {
    --term-green: #1a7f37;
    --term-purple: #8250df;
    --term-coral: #e85d75;
    --term-teal: #0e8a94;
    --term-bg: rgba(255, 255, 255, 0.92);
    --term-border: rgba(130, 80, 223, 0.28);
  }

  body {
    background: linear-gradient(135deg, #e8efe4 0%, #dfe9f0 50%, #e5ebe0 100%);
    font-family: "JetBrains Mono", "IBM Plex Mono", "Courier New", monospace;
  }

  #deck-container {
    filter: saturate(1.06) contrast(1.03) brightness(1.01);
    position: relative;
    transition: filter 0.65s ease;
  }

  #deck-container.trail-pulse-focus {
    filter: saturate(0.82) contrast(1.12) brightness(0.42);
  }

  #deck-container.trail-pulse-focus::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 12;
    background:
      radial-gradient(ellipse at 50% 45%, rgba(0, 0, 0, 0.08) 0%, rgba(0, 0, 0, 0.52) 100%),
      rgba(8, 12, 24, 0.28);
    transition: opacity 0.65s ease;
  }

  body.trail-pulse-focus {
    background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0c1222 100%);
  }

  #route-stage {
    position: fixed;
    inset: 0;
    pointer-events: none !important;
    z-index: 15;
  }

  #route-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none !important;
  }

  #deck-container.trail-pulse-focus #route-stage {
    filter: drop-shadow(0 0 6px rgba(252, 76, 2, 0.55)) drop-shadow(0 0 14px rgba(252, 76, 2, 0.25));
  }

  #route-stage.heatmap-interactive {
    cursor: crosshair;
  }

  .route-detail {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--term-border);
    max-height: 176px;
    overflow: auto;
  }

  .strava-panel .segment-chip { font-size: 0.55rem; }

  .run-card {
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px solid rgba(252, 76, 2, 0.25);
    background: rgba(252, 76, 2, 0.06);
  }

  .run-card--clickable {
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }

  .run-card--clickable:hover {
    border-color: rgba(252, 76, 2, 0.55);
    background: rgba(252, 76, 2, 0.12);
  }

  .run-card--active {
    border-color: rgba(130, 80, 223, 0.55);
    background: rgba(130, 80, 223, 0.08);
  }

  .run-card--active .run-card__name { color: #8250df; }

  .segment-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    margin: 8px 0;
  }

  .segment-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.68rem;
    color: var(--term-green);
  }

  .segment-chip--dim { opacity: 0.45; }

  .segment-chip__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .segment-thresholds { margin-bottom: 8px; line-height: 1.45; }

  .run-card__name {
    color: #fc4c02;
    font-weight: 500;
    margin-bottom: 4px;
  }

  #deck-container::after {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2;
    background: repeating-linear-gradient(
      0deg,
      rgba(0, 0, 0, 0.012) 0px,
      rgba(0, 0, 0, 0.012) 1px,
      transparent 1px,
      transparent 4px
    );
  }

  .hud {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 20;
    color: var(--term-green);
    font-size: 0.74rem;
    line-height: 1.55;
  }

  .hud-panel {
    position: absolute;
    background: var(--term-bg);
    border: 1px solid var(--term-border);
    padding: 10px 14px;
    letter-spacing: 0.02em;
    backdrop-filter: blur(6px);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
  }

  .hud-panel--tl {
    top: 20px;
    left: 20px;
    font-size: 0.59rem;
    padding: 8px 11px;
    pointer-events: auto;
  }

  .hud-panel--br { bottom: 20px; right: 20px; min-width: 280px; }

  .hud-panel--tl[hidden] { display: none; }

  body.trail-analysis-mode #hud-help,
  body.city-mobility-mode #hud-help {
    display: none !important;
  }

  .pulse-menu {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .pulse-menu__item {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    letter-spacing: inherit;
    padding: 2px 0;
    cursor: pointer;
    color: inherit;
  }

  .pulse-menu__item:hover .pulse-menu__label {
    text-decoration: underline;
  }

  .pulse-menu__label--trail { color: #d97706; }
  .pulse-menu__label--city { color: #0550ae; }

  .hud-prompt { color: var(--term-purple); }
  .hud-dim { color: #57606a; }
  .hud-key { color: var(--term-coral); }
  .hud-val { color: #0550ae; }
  .hud-ok { color: var(--term-teal); }

  .strava-panel {
    position: fixed;
    top: 20px;
    right: 20px;
    width: min(304px, calc(100vw - 40px));
    max-height: calc(100vh - 40px);
    overflow: auto;
    z-index: 30;
    background: var(--term-bg);
    border: 1px solid var(--term-border);
    padding: 10px 11px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    pointer-events: auto;
    font-size: 0.59rem;
    line-height: 1.45;
  }

  .strava-panel[hidden] { display: none; }

  .strava-panel__head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .strava-panel__title { color: var(--term-purple); font-weight: 500; }

  .strava-close,
  .btn-primary,
  .btn-secondary {
    border: 1px solid var(--term-border);
    background: white;
    color: #57606a;
    font-family: inherit;
    font-size: 0.58rem;
    cursor: pointer;
    padding: 3px 8px;
  }

  .btn-primary {
    background: #fc4c02;
    color: white;
    border-color: #fc4c02;
    margin-top: 8px;
  }

  .btn-secondary { margin-top: 8px; }

  .utct-coach {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid var(--term-border);
  }

  .utct-coach__question {
    margin: 6px 0 8px;
    color: #24292f;
    line-height: 1.5;
  }

  .utct-coach__btn {
    white-space: normal;
    line-height: 1.45;
    text-align: left;
    padding: 6px 8px;
  }

  .utct-coach__answer {
    margin-top: 10px;
    padding: 8px;
    border: 1px solid var(--term-border);
    background: #f6f8fa;
  }

  .utct-coach__text {
    margin-top: 6px;
    color: #24292f;
    line-height: 1.55;
  }

  .trail-coach__input {
    display: block;
    width: 100%;
    margin-top: 6px;
    padding: 6px 7px;
    border: 1px solid var(--term-border);
    font-family: inherit;
    font-size: 0.58rem;
    line-height: 1.45;
    resize: vertical;
    min-height: 52px;
    box-sizing: border-box;
  }

  .trail-coach__actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    flex-wrap: wrap;
  }

  .trail-coach__hint {
    margin-top: 6px;
  }

  .coach-plots {
    margin-top: 10px;
    display: grid;
    gap: 10px;
  }

  .coach-plot {
    padding: 6px 0 0;
    border-top: 1px solid var(--term-border);
  }

  .coach-plot canvas {
    width: 100% !important;
    max-height: 160px;
  }

  .strava-link { color: #0550ae; text-decoration: none; }
  .strava-link:hover { text-decoration: underline; }

  .trail-intro {
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--term-border);
  }

  .trail-intro__text {
    margin: 6px 0 0;
    color: #24292f;
    line-height: 1.55;
  }

  .trail-intro__cta {
    margin-top: 8px;
    color: #57606a;
  }

  .range-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }

  .range-row input[type="date"] {
    font-family: inherit;
    font-size: 0.58rem;
    border: 1px solid var(--term-border);
    padding: 3px 5px;
    flex: 1;
  }

  .player-controls {
    margin-top: 10px;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    align-items: center;
  }

  .player-controls input[type="range"] { width: 100%; }

  .timeline-meta {
    display: flex;
    justify-content: space-between;
    font-size: 0.52rem;
    color: #57606a;
    margin-top: 4px;
  }

  #timeline-label {
    grid-column: 1 / -1;
    font-size: 0.55rem;
  }

  #viz-charts {
    position: fixed;
    left: 20px;
    right: 20px;
    bottom: 20px;
    z-index: 25;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    pointer-events: none;
  }

  #viz-charts[hidden] { display: none; }

  #run-explorer-charts {
    position: fixed;
    left: 20px;
    right: 20px;
    bottom: 20px;
    z-index: 25;
    pointer-events: none;
  }

  #run-explorer-charts[hidden] { display: none; }

  #segment-analysis-charts {
    position: fixed;
    left: 20px;
    right: 20px;
    bottom: 20px;
    z-index: 25;
    pointer-events: none;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  #segment-analysis-charts[hidden] { display: none; }

  #segment-analysis-charts.segment-analysis-charts--in-panel {
    position: static;
    left: auto;
    right: auto;
    bottom: auto;
    z-index: auto;
    grid-template-columns: 1fr;
    margin-top: 10px;
    gap: 10px;
    pointer-events: auto;
  }

  #segment-analysis-charts.segment-analysis-charts--in-panel .chart-card--wide {
    height: 170px;
  }

  body.trail-pulse-focus #segment-analysis-charts:not(.segment-analysis-charts--in-panel) {
    z-index: 40;
    left: 20px;
    right: min(340px, calc(100vw - 40px));
  }

  @media (max-width: 900px) {
    #segment-analysis-charts { grid-template-columns: 1fr; }
  }

  .mode-actions { margin-top: 10px; }

  .analysis-list {
    margin-top: 8px;
    max-height: 180px;
    overflow: auto;
  }

  .segment-chip--clickable {
    cursor: pointer;
    border-radius: 3px;
    padding: 1px 4px;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: inherit;
  }

  .segment-chip--clickable:hover {
    background: rgba(130, 80, 223, 0.08);
  }

  .segment-chip--active {
    background: rgba(130, 80, 223, 0.14);
    outline: 1px solid rgba(130, 80, 223, 0.45);
  }

  .chart-card--wide { height: 190px; }

  .chart-card--wide canvas { height: 150px !important; }

  .chart-card {
    background: var(--term-bg);
    border: 1px solid var(--term-border);
    padding: 8px 10px 4px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
    height: 160px;
  }

  .chart-card__title {
    font-size: 0.68rem;
    color: var(--term-purple);
    margin-bottom: 4px;
  }

  .chart-card canvas { width: 100% !important; height: 120px !important; }

  .mobility-activity__name { color: #0550ae; font-weight: 500; }

  .maplibregl-ctrl-attrib,
  .maplibregl-ctrl-attrib a {
    font-family: "JetBrains Mono", monospace !important;
    font-size: 10px !important;
    color: #57606a !important;
    background: rgba(255, 255, 255, 0.85) !important;
  }

  .deck-widget,
  [class*="info-widget"],
  [class*="InfoWidget"] {
    display: none !important;
  }

  @media (max-width: 900px) {
    #viz-charts { grid-template-columns: 1fr; }
    .hud-panel--br { display: none; }
  }
</style>
"""

HUD_BODY = """
<div class="hud">
  <nav class="hud-panel hud-panel--tl" id="hud-help" aria-label="Map modules">
    <ul class="pulse-menu">
      <li>
        <button type="button" class="pulse-menu__item" id="pulse-trail-btn">
          <span class="hud-dim">→</span>
          <span class="pulse-menu__label pulse-menu__label--trail">trail analysis</span>
        </button>
      </li>
      <li>
        <button type="button" class="pulse-menu__item" id="pulse-city-btn">
          <span class="hud-dim">→</span>
          <span class="pulse-menu__label pulse-menu__label--city">city mobility pulse</span>
        </button>
      </li>
    </ul>
  </nav>

  <div class="hud-panel hud-panel--br">
    <div><span class="hud-dim">viewport.</span><span class="hud-key">lat</span> = <span class="hud-val" id="hud-lat">{lat}</span></div>
    <div><span class="hud-dim">viewport.</span><span class="hud-key">lng</span> = <span class="hud-val" id="hud-lng">{lng}</span></div>
    <div><span class="hud-dim">viewport.</span><span class="hud-key">zoom</span> = <span class="hud-val" id="hud-zoom">{zoom}</span></div>
    <div><span class="hud-dim">viewport.</span><span class="hud-key">pitch</span> = <span class="hud-val" id="hud-pitch">{pitch}</span></div>
    <div class="hud-dim">basemap · OpenTopoMap</div>
  </div>
</div>

<div id="route-stage" hidden>
  <canvas id="route-overlay"></canvas>
</div>

<div id="strava-panel" class="strava-panel" hidden>
  <div class="strava-panel__head">
    <div class="strava-panel__title" id="pulse-panel-title">pulse.handler()</div>
    <button type="button" class="strava-close" id="strava-close">close</button>
  </div>
  <div id="strava-content" class="hud-dim">awaiting click...</div>
</div>

<div id="viz-charts" hidden>
  <div class="chart-card">
    <div class="chart-card__title">cumulative distance (timeline)</div>
    <canvas id="distance-chart"></canvas>
  </div>
  <div class="chart-card">
    <div class="chart-card__title">cumulative elevation (timeline)</div>
    <canvas id="elevation-chart"></canvas>
  </div>
</div>

<div id="run-explorer-charts" hidden>
  <div class="chart-card chart-card--wide">
    <div class="chart-card__title" id="run-elevation-title">run elevation</div>
    <canvas id="run-elevation-chart"></canvas>
  </div>
</div>

<div id="segment-analysis-charts" hidden>
  <div class="chart-card chart-card--wide">
    <div class="chart-card__title" id="segment-pace-chart-title">segment pace · time</div>
    <canvas id="segment-pace-chart"></canvas>
  </div>
  <div class="chart-card chart-card--wide">
    <div class="chart-card__title" id="segment-elevation-chart-title">segment elevation</div>
    <canvas id="segment-elevation-chart"></canvas>
  </div>
</div>
"""

HUD_SCRIPT = """
    const hudLat = document.getElementById("hud-lat");
    const hudLng = document.getElementById("hud-lng");
    const hudZoom = document.getElementById("hud-zoom");
    const hudPitch = document.getElementById("hud-pitch");
    const stravaPanel = document.getElementById("strava-panel");
    const stravaClose = document.getElementById("strava-close");
    const hudHelp = document.getElementById("hud-help");
    const pulseTrailBtn = document.getElementById("pulse-trail-btn");
    const pulseCityBtn = document.getElementById("pulse-city-btn");

    function hideHudHelp() {
      if (hudHelp) hudHelp.hidden = true;
    }

    function showHudHelp() {
      if (hudHelp) hudHelp.hidden = false;
    }

    function updateHud(viewState) {
      if (!viewState) return;
      hudLat.textContent = viewState.latitude.toFixed(4);
      hudLng.textContent = viewState.longitude.toFixed(4);
      hudZoom.textContent = viewState.zoom.toFixed(1);
      hudPitch.textContent = Math.round(viewState.pitch || 0);
    }

    window.updatePulseLayers = function () {};

    function enterTrailAnalysisMode() {
      document.body.classList.add("trail-analysis-mode");
      document.body.classList.remove("city-mobility-mode");
      hideHudHelp();
    }

    function enterCityMobilityMode() {
      document.body.classList.remove("trail-analysis-mode");
      document.body.classList.add("city-mobility-mode");
      hideHudHelp();
    }

    function exitModuleMode() {
      document.body.classList.remove("trail-analysis-mode");
      document.body.classList.remove("city-mobility-mode");
      showHudHelp();
    }

    window.enterTrailAnalysisMode = enterTrailAnalysisMode;
    window.exitTrailAnalysisMode = exitModuleMode;

    function openTrailAnalysis() {
      enterTrailAnalysisMode();
      window.history.pushState({ pulse: "trail" }, "", "/maps/trail");
      TrailPulseViz.open({ skipUrl: true, skipLayers: true });
    }

    function handleCityMobilityPulseClick() {
      enterCityMobilityMode();
      const title = document.getElementById("pulse-panel-title");
      const content = document.getElementById("strava-content");
      if (window.TrailPulseViz) {
        TrailPulseViz.stop();
        TrailPulseViz.setFocus(false, { skipUrl: true, skipLayers: true });
      }
      stravaPanel.hidden = false;
      title.textContent = "city mobility pulse";
      content.innerHTML =
        '<div class="hud-dim"># module pending</div>' +
        '<div class="mobility-activity__name">city mobility pulse</div>' +
        '<div style="margin-top:8px">Mobility data integration coming soon.</div>';
    }

    if (pulseTrailBtn) pulseTrailBtn.addEventListener("click", openTrailAnalysis);
    if (pulseCityBtn) pulseCityBtn.addEventListener("click", handleCityMobilityPulseClick);

    stravaClose.addEventListener("click", function () {
      stravaPanel.hidden = true;
      if (window.TrailPulseViz) {
        TrailPulseViz.stop();
        TrailPulseViz.setFocus(false, { skipLayers: true });
      }
      exitModuleMode();
      if (window.location.pathname === "/maps/trail") {
        window.history.replaceState({}, "", "/maps");
      }
    });

    window.addEventListener("popstate", function () {
      if (window.location.pathname === "/maps/trail") {
        enterTrailAnalysisMode();
        TrailPulseViz.open({ skipUrl: true, skipLayers: true });
        return;
      }
      stravaPanel.hidden = true;
      if (window.TrailPulseViz) {
        TrailPulseViz.stop();
        TrailPulseViz.setFocus(false, { skipLayers: true });
      }
      exitModuleMode();
    });

    TrailPulseViz.init(deckInstance);

    fetch("/api/config")
      .then(function (response) {
        return response.json();
      })
      .then(function (cfg) {
        if (cfg.trail_map_only && pulseCityBtn) {
          const row = pulseCityBtn.closest("li");
          if (row) row.hidden = true;
        }
        if (cfg.auto_open_trail && window.location.pathname === "/maps") {
          openTrailAnalysis();
        }
      })
      .catch(function () {});

    const urlParams = new URLSearchParams(window.location.search);
    const stravaStatus = urlParams.get("strava");
    if (stravaStatus === "connected") {
      enterTrailAnalysisMode();
      TrailPulseViz.open({ skipUrl: true, skipLayers: true });
      window.history.replaceState({}, "", "/maps/trail");
    } else if (stravaStatus) {
      window.history.replaceState({}, "", "/maps");
    }

    deckInstance.setProps({
      onViewStateChange: ({ viewState }) => {
        updateHud(viewState);
        TrailPulseViz.redrawRoutes();
        return viewState;
      },
    });

    updateHud(deckInstance.viewState || jsonInput.initialViewState);
"""


def build_map() -> pdk.Deck:
    view_state = pdk.ViewState(
        latitude=MAP_CENTER_LAT,
        longitude=MAP_CENTER_LNG,
        zoom=ZOOM,
        pitch=PITCH,
        bearing=BEARING,
        min_zoom=9,
        max_zoom=17,
    )

    return pdk.Deck(
        layers=[],
        map_style=TRAIL_BASEMAP,
        map_provider="carto",
        initial_view_state=view_state,
    )


def _inject_terminal_ui(html: str) -> str:
    html = html.replace("<title>pydeck</title>", "<title>map_cape_town.py</title>")
    html = re.sub(r'"description":\s*"[^"]*",?\n?', "", html)
    html = re.sub(
        r'\s*<script src="https://api\.tiles\.mapbox\.com/mapbox-gl-js/v1\.13\.0/mapbox-gl\.js"></script>\s*',
        "\n",
        html,
    )
    html = html.replace("</head>", f"{HUD_HEAD}</head>")
    html = html.replace(
        "<body>",
        f"<body>{HUD_BODY.format(node_count=len(PULSES), lat=MAP_CENTER_LAT, lng=MAP_CENTER_LNG, zoom=ZOOM, pitch=PITCH)}",
    )
    html = re.sub(
        r"(const deckInstance = createDeck\([\s\S]*?\);\s*)",
        lambda m: m.group(1) + HUD_SCRIPT,
        html,
        count=1,
    )
    return html


def main() -> None:
    output = Path(__file__).resolve().parent / "output" / "cape_town_map.html"
    output.parent.mkdir(parents=True, exist_ok=True)

    build_map().to_html(str(output))
    output.write_text(_inject_terminal_ui(output.read_text(encoding="utf-8")), encoding="utf-8")

    print(f"Map saved to:\n  {output}")
    print("\nRun the server for Strava:")
    print("  python server.py")
    print("  open http://localhost:5000")


if __name__ == "__main__":
    main()
