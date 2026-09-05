# OmniAnalytics

A dashboard for analyzing `pp_*` session recordings (spatial-navigation / O&M research trials), with a Python/FastAPI backend and a React/Recharts frontend.

It replaces an earlier `ipywidgets + matplotlib` notebook workflow, and is structured so a future realtime dashboard can be layered on top of the same backend.

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Data configuration](#data-configuration)
- [Trajectory smoothing (`alpha`)](#trajectory-smoothing-alpha)
- [Project structure](#project-structure)
- [Future work: realtime integration](#future-work-realtime-integration)

## Features

**Session browsing**
- Auto-discovers `pp_00_sessions/`, `pp_01_sessions/`, etc. under a configurable data directory.
- Patient / condition / phase (`learning` / `exploration`) / path / session dropdowns.
- 2D trajectory playback with offline smoothing (`alpha`) and an optional realtime-cooked overlay.
- Responsive Recharts time series (speed, distance, feedback intensity, orientation) with synchronized cursor and brush.

**Trial metrics** — learning vs. exploration comparison per (patient, condition, path):
- Route similarity: nearest-neighbor overlap, shape overlap/deviation, discrete Fréchet distance, Dynamic Time Warping, Longest Common Subsequence — each resampled to 100 equal-arc-length points so pacing differences don't distort the comparison.
- Turn deviation, stop/border-crossing counts, start/stop position error.
- Target discovery: found/not-found per target, order-of-discovery vs. the taught route, path efficiency, endpoint (homing) error.
- A heuristic 1–5 performance score, shown alongside the same facts reported as individual, unweighted navigation metrics for comparison — plus a dataset-wide speed/acceleration correlation check explaining why those aren't weighted into the score.

**General statistics** — aggregated across patients:
- Session/trial totals with learning-vs-exploration breakdowns.
- Behavioral breakdown: targets-found buckets (in order / out of order), return-to-start success against an editable distance threshold, per-patient trial-outcome table, success rate by condition, proximity escalation, fastest completion per path.
- A "complete cases only" toggle to compare conditions fairly when some (e.g. a condition with more excluded/missing trials) have fewer contributing patients than others.
- Per-condition target counts against a theoretical maximum (patients × paths × targets), so shortfalls from missing/excluded trials are visible at a glance.

**Manual data corrections** — for sensor gaps or collection-time mistakes, persisted server-side without ever touching the raw session JSON:
- Manual target coordinates for conditions that never tracked the target tags (distance-based "found" fallback).
- Manual found/in-order override per target/trial, for when the automatic detection still gets it wrong.
- Per-trial annotations: manual lost/not-lost override, exclude-from-statistics flag, free-text notes.
- Phase swap (learning ↔ exploration) for sessions mislabeled at recording time.
- Per-patient opt-out from General statistics.

**Export tools**
- Copy any table or chart to the clipboard as a PNG (client-side rasterization).
- Copy any LaTeX-rendered formula (route-similarity/navigation-metric definitions) as a PNG.
- Download a presentation-quality chart PNG rendered server-side with matplotlib, for consistent styling regardless of the viewer's browser/zoom.

## Requirements

- Python 3.10+
- Node.js 18+
- npm

## Getting started

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export DATA_DIR=/home/jota/Downloads/third_analysis_dataset/Pilot/pp_study
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- API: <http://127.0.0.1:8000>
- Interactive API docs (Swagger): <http://127.0.0.1:8000/docs>

### Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

- App: <http://127.0.0.1:5173>

## Data configuration

The backend reads session files from `DATA_DIR`. The folder must look like:

```text
pp_study/
  pp_00_sessions/
    pp_00_2026-..._learning_..._path_A.json
  pp_01_sessions/
    pp_01_2026-..._exploration_..._path_A.json
```

Everything the app writes manually (annotations, patient inclusion, manual target coordinates, manual discovery overrides, phase overrides) is stored in small JSON sidecar files under `backend/app/` — the raw session files are never modified. `POST /api/refresh` re-scans `DATA_DIR` and clears the backend's in-memory caches.

## Trajectory smoothing (`alpha`)

- `x/y/z` are the original cooked values from the JSON source.
- `x_plot/y_plot/z_plot` are computed only for the 2D chart — they never overwrite the raw fields.
- A low `alpha` (e.g. `0.15–0.25`) produces a smoother offline trajectory.
- `alpha = 0.4` approximates the realtime-cooked trajectory.
- `alpha = 1.0` disables offline smoothing entirely.

## Project structure

```text
backend/app/
  main.py              REST API (FastAPI routes)
  analysis.py           Parsing, metrics, and dataframe construction
  annotations.py        Per-trial manual annotations (lost flag, notes, exclusion)
  inclusion.py           Per-patient General-statistics opt-out
  target_coordinates.py  Manual target coordinates (untracked-sensor fallback)
  manual_discovery.py    Manual found/in-order overrides
  phase_overrides.py     Learning/exploration relabeling
  charts.py               Server-rendered (matplotlib) chart export
  settings.py             Configuration (paths, thresholds, weights)

frontend/src/
  api.ts                  API client
  App.tsx                  Top-level layout, shared data fetching/caching
  components/              Dashboard panels and charts
  lib/                      Aggregation helpers
```

## Future work: realtime integration

The backend/frontend split already isolates parsing and metrics (`backend/app/analysis.py`) from the API layer (`backend/app/main.py`) and from the UI (`frontend/src/components/*`, talking only to `frontend/src/api.ts`). Adding a realtime data source should only require new WebSocket/SSE endpoints in the backend — the existing UI components shouldn't need to change.
