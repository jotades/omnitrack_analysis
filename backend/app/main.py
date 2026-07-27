from __future__ import annotations

from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .analysis import (
    clear_caches,
    compare_sessions,
    compare_trials,
    df_records,
    get_sessions_df,
    load_session_payload,
)
from .settings import get_settings

settings = get_settings()

app = FastAPI(
    title="Jota Interactive Dashboard API",
    version="0.1.0",
    description="Backend Python per dashboard sessioni pp_* con metriche, smoothing e confronto.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "data_dir": str(settings.data_dir.expanduser()),
        "realtime_cooked_alpha": settings.realtime_cooked_alpha,
        "default_plot_alpha": settings.default_plot_alpha,
    }


@app.post("/api/refresh")
def refresh_index():
    try:
        clear_caches()
        df = get_sessions_df()
        return {"ok": True, "sessions": int(len(df))}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/sessions")
def sessions():
    try:
        df = get_sessions_df().copy()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    cols = [
        "session_id",
        "patient",
        "condition",
        "condition_label",
        "phase",
        "path_id",
        "start_time",
        "total_samples",
        "n_raw",
        "duration_s",
        "last_state",
        "status",
        "is_interrupt",
        "is_suspicious_short",
        "warning",
        "file_name",
    ]
    return {"sessions": df_records(df[cols])}


@app.get("/api/options")
def options():
    try:
        df = get_sessions_df()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if df.empty:
        return {"patients": [], "conditions": [], "phases": ["all", "learning", "exploration"], "paths": []}
    conditions = (
        df[["condition", "condition_label"]]
        .drop_duplicates()
        .sort_values("condition_label")
        .to_dict(orient="records")
    )
    return {
        "patients": sorted(df["patient"].dropna().unique().tolist()),
        "conditions": conditions,
        "phases": ["all", "learning", "exploration"],
        "paths": sorted(df["path_id"].dropna().unique().tolist()),
    }


@app.get("/api/session/{session_id}")
def session_detail(
    session_id: int,
    alpha: float = Query(0.2, ge=0.001, le=1.0),
    smooth_trajectory: bool = Query(True),
    smooth_only_seeker: bool = Query(True),
    max_points: int = Query(2000, ge=200, le=20000),
):
    try:
        return load_session_payload(
            session_id=session_id,
            alpha=alpha,
            smooth_trajectory=smooth_trajectory,
            smooth_only_seeker=smooth_only_seeker,
            max_points=max_points,
        )
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/compare")
def compare(
    patients: Optional[List[str]] = Query(None),
    condition: Optional[str] = Query(None),
    path_id: Optional[str] = Query(None),
    phase: Optional[str] = Query("all"),
    include_suspicious: bool = Query(True),
):
    try:
        rows = compare_sessions(
            patients=patients,
            condition=condition,
            path_id=path_id,
            phase=phase,
            include_suspicious=include_suspicious,
        )
        return {"rows": rows}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/trials/compare")
def trials_compare(
    patients: Optional[List[str]] = Query(None),
    condition: Optional[str] = Query(None),
    path_id: Optional[str] = Query(None),
    include_suspicious: bool = Query(True),
):
    try:
        rows = compare_trials(
            patients=patients,
            condition=condition,
            path_id=path_id,
            include_suspicious=include_suspicious,
        )
        return {"rows": rows}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
