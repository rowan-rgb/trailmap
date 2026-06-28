# Deploy trail map on Render (public read-only demo)

This deploys **only the trail map** at `/maps` using your **local Strava run cache** (~148 runs). Visitors do not need Strava. Sync and AI coach are disabled on the public demo.

## What gets deployed

- Flask app + map UI
- `.data/strava_runs/` — your cached GPS + segment data (must be in git)
- No `.env`, no Strava tokens, no OpenAI key required

## One-time: add run cache to git

The cache is allowed in git via `.gitignore` exceptions, but you must add it explicitly:

```bash
cd "/Users/rowandavies/Desktop/Cursor AI/Website Viz"

# Never commit secrets
test ! -f .data/strava_tokens.json && echo "OK: no token file"

git add -f .data/strava_runs/
git add render.yaml Procfile requirements.txt server.py static/ strava_*.py map_cape_town.py trail_coach.py download_strava_runs.py .gitignore
git status   # confirm ~150 json files under .data/strava_runs/
git commit -m "Add Render deploy config and public trail map cache"
git push
```

Use a **private GitHub repo** if you prefer not to publish GPS tracks in git history.

## Create the Render service

1. Go to [render.com](https://render.com) → **New** → **Blueprint** (or **Web Service** if you prefer manual setup).
2. Connect your GitHub repo.
3. If using **Blueprint**, Render reads `render.yaml` automatically.
4. If manual:
   - **Runtime:** Python 3
   - **Build command:** `pip install -r requirements.txt && python map_cape_town.py`
   - **Start command:** `gunicorn --timeout 120 -w 2 -b 0.0.0.0:$PORT server:app`
   - **Health check path:** `/health`

## Environment variables (set in Render dashboard)

| Variable | Value | Required |
|----------|--------|----------|
| `PUBLIC_DEMO` | `1` | Yes — hides Strava sync + AI coach |
| `TRAIL_MAP_ONLY` | `1` | Yes — `/` redirects to `/maps`, hides city mobility |
| `FLASK_SECRET_KEY` | random string | Yes — Render can auto-generate |
| `PYTHON_VERSION` | `3.12.7` | Recommended |

Do **not** set `STRAVA_CLIENT_ID` / `OPENAI_API_KEY` unless you want those features on the server.

## After deploy

1. Open `https://YOUR-SERVICE.onrender.com/` → redirects to `/maps`
2. Trail analysis opens automatically
3. Pick date range → **load runs**
4. Use **timeline** or **segment analysis**

Verify health: `https://YOUR-SERVICE.onrender.com/health`  
Should show `"cached_runs": 148` (or your count).

## Updating runs later

1. On your Mac: `.venv/bin/python download_strava_runs.py` (with Strava connected locally)
2. `git add -f .data/strava_runs/ && git commit && git push`
3. Render redeploys automatically

## Local production test

```bash
PUBLIC_DEMO=1 TRAIL_MAP_ONLY=1 gunicorn --timeout 120 -w 1 -b 127.0.0.1:5000 server:app
open http://127.0.0.1:5000/maps
```

## Free tier notes

- Service sleeps after ~15 min idle; first visit may take 30–60s to wake.
- Ephemeral disk is fine because the cache is **in git**, not uploaded at runtime.

## Privacy

Public visitors can see GPS tracks, dates, paces, and segment names in your loaded date range. Only deploy if you are comfortable with that.
