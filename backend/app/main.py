from __future__ import annotations

from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from .analysis import (
    clear_caches,
    compare_sessions,
    compare_trials,
    compute_speed_accel_correlations,
    df_records,
    get_sessions_df,
    load_session_payload,
    save_activation_distance,
    trials_summary_by_patient,
)
from .annotations import save_annotation
from .charts import render_bar_chart_png
from .inclusion import load_inclusion, save_inclusion
from .manual_discovery import load_manual_discovery_overrides, save_manual_in_order, save_manual_target_found
from .phase_overrides import swap_phase_pair
from .target_coordinates import load_target_coordinates, save_target_coordinate
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
        .dropna()
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


@app.get("/api/performance/correlations")
def performance_correlations():
    """Dataset-wide Pearson correlation between speed/acceleration and trial
    outcome — the evidence shown in the performance score's info popover for
    why those two aren't weighted into the 1-5 rating itself. See
    compute_speed_accel_correlations' docstring."""
    try:
        return compute_speed_accel_correlations()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/trials/summary")
def trials_summary(patients: Optional[List[str]] = Query(None)):
    try:
        return {"rows": trials_summary_by_patient(patients=patients)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class AnnotationIn(BaseModel):
    patient: str
    condition: str
    path_id: str
    exploration_session_id: Optional[int] = None
    manual_lost: Optional[bool] = None
    comment: str = ""
    excluded_from_stats: bool = False


@app.post("/api/annotations")
def upsert_annotation(payload: AnnotationIn):
    try:
        return save_annotation(
            payload.patient,
            payload.condition,
            payload.path_id,
            payload.exploration_session_id,
            payload.manual_lost,
            payload.comment,
            payload.excluded_from_stats,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/patient-inclusion")
def patient_inclusion():
    try:
        return {"inclusion": load_inclusion()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class PatientInclusionIn(BaseModel):
    patient: str
    included: bool


@app.post("/api/patient-inclusion")
def upsert_patient_inclusion(payload: PatientInclusionIn):
    try:
        return {"inclusion": save_inclusion(payload.patient, payload.included)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/target-coordinates")
def target_coordinates():
    try:
        return {"coordinates": load_target_coordinates()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class TargetCoordinateIn(BaseModel):
    patient: str
    condition: str
    path_id: str
    target_id: str
    x: float
    y: float


@app.post("/api/target-coordinates")
def upsert_target_coordinate(payload: TargetCoordinateIn):
    try:
        record = save_target_coordinate(payload.patient, payload.condition, payload.path_id, payload.target_id, payload.x, payload.y)
        return {"coordinates": record}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/manual-discovery")
def manual_discovery():
    try:
        return {"overrides": load_manual_discovery_overrides()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class ManualTargetFoundIn(BaseModel):
    patient: str
    condition: str
    path_id: str
    target_id: str
    # null clears the override and reverts to automatic detection
    found: Optional[bool] = None


@app.post("/api/manual-discovery/target-found")
def upsert_manual_target_found(payload: ManualTargetFoundIn):
    try:
        record = save_manual_target_found(payload.patient, payload.condition, payload.path_id, payload.target_id, payload.found)
        return {"override": record}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class ManualInOrderIn(BaseModel):
    patient: str
    condition: str
    path_id: str
    # null clears the override and reverts to automatic detection
    in_order: Optional[bool] = None


@app.post("/api/manual-discovery/in-order")
def upsert_manual_in_order(payload: ManualInOrderIn):
    try:
        record = save_manual_in_order(payload.patient, payload.condition, payload.path_id, payload.in_order)
        return {"override": record}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class PhaseSwapIn(BaseModel):
    # The two files currently resolving to learning/exploration for this
    # trial — the researcher picked the wrong phase at recording time, so we
    # swap which is which. Never edits the raw session JSON files.
    learning_file_name: str
    exploration_file_name: str


@app.post("/api/phase-swap")
def phase_swap(payload: PhaseSwapIn):
    try:
        swap_phase_pair(payload.learning_file_name, payload.exploration_file_name)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class ActivationDistanceIn(BaseModel):
    min_activation_distance: float
    max_activation_distance: float


@app.post("/api/session/{session_id}/activation-distance")
def upsert_activation_distance(session_id: int, payload: ActivationDistanceIn):
    try:
        return save_activation_distance(session_id, payload.min_activation_distance, payload.max_activation_distance)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class BarChartIn(BaseModel):
    title: str
    labels: List[str]
    values: List[float]
    y_label: str = "%"
    y_max: float = 100.0
    y_major_unit: float = 25.0
    color: str = "#3b5bfd"


@app.post("/api/charts/bar-png")
def bar_chart_png(payload: BarChartIn):
    """Server-rendered (matplotlib) presentation-ready bar chart, as an
    alternative to screenshotting the live recharts version — a downloadable
    PNG with the same look on every browser/zoom level."""
    try:
        png_bytes = render_bar_chart_png(
            title=payload.title,
            labels=payload.labels,
            values=payload.values,
            y_label=payload.y_label,
            y_max=payload.y_max,
            y_major_unit=payload.y_major_unit,
            color=payload.color,
        )
        return Response(content=png_bytes, media_type="image/png")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
