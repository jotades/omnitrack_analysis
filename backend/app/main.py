from __future__ import annotations

from pathlib import Path

from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from .analysis import (
    clear_caches,
    clear_derived_caches,
    compare_sessions,
    compare_trials,
    compute_anova_results,
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
from .route_overrides import load_route_overrides
from .stats_exclusions import load_stats_exclusions
from .annotations import annotation_key
from .target_coordinates import coord_key
from . import change_log
from .target_coordinates import load_target_coordinates, save_target_coordinate
from .task_split import load_task_splits, save_task_split
from .observations import load_observations, save_observation
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


_COND_SHORT = {
    "auditory_on_person_intes": "AP", "auditory_on_object_intes": "AE",
    "haptic_on_person_intes": "HP", "haptic_on_object_intes": "HE",
}


def _trial_name(patient: str, condition: str, path_id: str) -> str:
    """'PP_17 AP route B' — the thesis' way of naming a trial."""
    return f"{str(patient).upper()} {_COND_SHORT.get(condition, condition)} route {str(path_id).replace('path_', '')}"


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "data_dir": str(settings.data_dir.expanduser()),
        "realtime_cooked_alpha": settings.realtime_cooked_alpha,
        "default_plot_alpha": settings.default_plot_alpha,
    }


@app.get("/api/pause-threshold")
def pause_threshold():
    """The position-noise threshold used for the pauses and how it was obtained."""
    try:
        from .analysis import get_pause_noise_threshold
        info = dict(get_pause_noise_threshold())
        info.pop("signature", None)
        info["relative_enabled"] = settings.pause_relative_enabled
        info["relative_fraction"] = settings.pause_relative_fraction
        info["min_duration_s"] = settings.pause_min_duration_s
        info["window_s"] = settings.pause_window_s
        info["data_gap_min_duration_s"] = settings.data_gap_min_duration_s
        return info
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/stats-exclusions")
def stats_exclusions():
    """Participants left out of the ANOVA and the mixed models, with the reason."""
    return {"excluded": load_stats_exclusions()}


@app.get("/api/changes")
def changes(limit: int = Query(100, ge=1, le=1000)):
    """Corrections saved from the dashboard, newest first."""
    return {"changes": change_log.list_changes(limit)}


@app.post("/api/changes/{change_id}/undo")
def undo_change(change_id: str):
    """Put back the value a logged correction replaced, and log the undo."""
    entry = change_log.find_change(change_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="change not found")
    if entry.get("undone_by"):
        raise HTTPException(status_code=409, detail="this change was already undone")
    if entry.get("undo_of"):
        raise HTTPException(status_code=409, detail="an undo cannot itself be undone; make the change again instead")
    try:
        if entry["kind"] == "activation_distance":
            from .analysis import get_sessions_df
            df = get_sessions_df()
            match = df.index[df["file_name"] == entry["recording"]]
            if not len(match):
                raise HTTPException(status_code=404, detail="recording not found")
            old = entry["before"]["activation_distance"]
            save_activation_distance(int(df.loc[match[0], "session_id"]), old["min_activation_distance"], old["max_activation_distance"])
            change_log.record("undo", f"Undone: {entry['summary']}", None, [], {}, extra={"undo_of": entry["id"]})
            clear_caches()
        else:
            path = Path(entry["file"])
            before = change_log.snapshot(path, entry["keys"])
            change_log.restore_file_keys(entry)
            change_log.record("undo", f"Undone: {entry['summary']}", path, entry["keys"], before, extra={"undo_of": entry["id"]})
            # Phase swaps change the recordings index itself; the others only
            # what is computed from it.
            if entry["kind"] == "phase_swap":
                clear_caches()
            else:
                clear_derived_caches()
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


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
    out = df[cols].copy()
    # Route actually set up (route_overrides.json); path_id stays the file-name letter.
    overrides = load_route_overrides()
    out["route_id"] = [
        overrides.get(f"{p}|{c}|{r}", r) if isinstance(r, str) else r
        for p, c, r in zip(out["patient"], out["condition"], out["path_id"])
    ]
    return {"sessions": df_records(out)}


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


@app.get("/api/anova")
def anova():
    """Two-way repeated-measures ANOVA (Modality x Location, subject=patient)
    per dependent variable — see compute_anova_results' docstring for the
    design, the complete-cases requirement, and why phase isn't a 3rd factor."""
    try:
        return compute_anova_results()
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
        key = annotation_key(payload.patient, payload.condition, payload.path_id, payload.exploration_session_id)
        before = change_log.snapshot(settings.annotations_path, [key])
        result = save_annotation(
            payload.patient,
            payload.condition,
            payload.path_id,
            payload.exploration_session_id,
            payload.manual_lost,
            payload.comment,
            payload.excluded_from_stats,
        )
        change_log.record(
            "annotation",
            f"{_trial_name(payload.patient, payload.condition, payload.path_id)} (exploration session {payload.exploration_session_id}): "
            f"excluded from statistics = {payload.excluded_from_stats}, lost = {payload.manual_lost}, note = {payload.comment!r}",
            settings.annotations_path, [key], before,
        )
        clear_derived_caches()  # excluded_from_stats changes who counts in ANOVA/correlations
        return result
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
        before = change_log.snapshot(settings.patient_inclusion_path, [payload.patient])
        result = {"inclusion": save_inclusion(payload.patient, payload.included)}
        change_log.record(
            "inclusion", f"{payload.patient.upper()}: shown in General statistics = {payload.included}",
            settings.patient_inclusion_path, [payload.patient], before,
        )
        clear_derived_caches()  # opting a patient in/out changes ANOVA's complete-case pool
        return result
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
    x: Optional[float] = None
    y: Optional[float] = None


@app.post("/api/target-coordinates")
def upsert_target_coordinate(payload: TargetCoordinateIn):
    try:
        key = coord_key(payload.patient, payload.condition, payload.path_id)
        before = change_log.snapshot(settings.target_coordinates_path, [key])
        record = save_target_coordinate(payload.patient, payload.condition, payload.path_id, payload.target_id, payload.x, payload.y)
        change_log.record(
            "landmark_position",
            f"{_trial_name(payload.patient, payload.condition, payload.path_id)}, landmark {payload.target_id}: position = "
            + (f"({payload.x:.2f}, {payload.y:.2f})" if payload.x is not None and payload.y is not None else "cleared"),
            settings.target_coordinates_path, [key], before,
        )
        clear_derived_caches()  # a moved target changes proximity/found/path-efficiency downstream
        return {"coordinates": record}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/task-split")
def task_splits():
    try:
        return {"splits": load_task_splits()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class TaskSplitIn(BaseModel):
    file_name: str
    t_s: Optional[float] = None
    x: Optional[float] = None
    y: Optional[float] = None


@app.post("/api/task-split")
def upsert_task_split(payload: TaskSplitIn):
    try:
        before = change_log.snapshot(settings.task_split_path, [payload.file_name])
        splits = save_task_split(payload.file_name, payload.t_s, payload.x, payload.y)
        old = before.get(payload.file_name)
        old_t = old.get("t_s") if isinstance(old, dict) else None
        change_log.record(
            "end_point",
            f"Point E of {payload.file_name}: "
            f"{'not marked' if old_t is None else f'{old_t:.1f} s'} -> {'cleared' if payload.t_s is None else f'{payload.t_s:.1f} s'}",
            settings.task_split_path, [payload.file_name], before,
        )
        clear_derived_caches()  # the marked point changes per-task and route-comparison metrics downstream
        return {"splits": splits}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/observations")
def observations():
    try:
        return {"observations": load_observations()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class ObservationIn(BaseModel):
    key: str
    text: str = ""


@app.post("/api/observations")
def upsert_observation(payload: ObservationIn):
    try:
        return {"observations": save_observation(payload.key, payload.text)}
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
        key = coord_key(payload.patient, payload.condition, payload.path_id)
        before = change_log.snapshot(settings.manual_discovery_path, [key])
        record = save_manual_target_found(payload.patient, payload.condition, payload.path_id, payload.target_id, payload.found)
        change_log.record(
            "landmark_reached",
            f"{_trial_name(payload.patient, payload.condition, payload.path_id)}, landmark {payload.target_id}: reached = "
            + ("automatic" if payload.found is None else str(payload.found)),
            settings.manual_discovery_path, [key], before,
        )
        clear_derived_caches()
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
        key = coord_key(payload.patient, payload.condition, payload.path_id)
        before = change_log.snapshot(settings.manual_discovery_path, [key])
        record = save_manual_in_order(payload.patient, payload.condition, payload.path_id, payload.in_order)
        change_log.record(
            "landmarks_in_order",
            f"{_trial_name(payload.patient, payload.condition, payload.path_id)}: landmarks in order = "
            + ("automatic" if payload.in_order is None else str(payload.in_order)),
            settings.manual_discovery_path, [key], before,
        )
        clear_derived_caches()
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
        keys = [payload.learning_file_name, payload.exploration_file_name]
        before = change_log.snapshot(settings.phase_overrides_path, keys)
        swap_phase_pair(payload.learning_file_name, payload.exploration_file_name)
        change_log.record(
            "phase_swap",
            f"Phases swapped: {payload.learning_file_name} -> exploration, {payload.exploration_file_name} -> learning",
            settings.phase_overrides_path, keys, before,
        )
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class ActivationDistanceIn(BaseModel):
    min_activation_distance: float
    max_activation_distance: float


@app.post("/api/session/{session_id}/activation-distance")
def upsert_activation_distance(session_id: int, payload: ActivationDistanceIn):
    try:
        from .analysis import extract_config, get_sessions_df, load_json_cached
        row = get_sessions_df().iloc[int(session_id)]
        cfg = extract_config(load_json_cached(str(row["file_path"])))["distance_cfg"]
        before = {"min_activation_distance": cfg.get("min_activation_distance"), "max_activation_distance": cfg.get("max_activation_distance")}
        result = save_activation_distance(session_id, payload.min_activation_distance, payload.max_activation_distance)
        change_log.record(
            "activation_distance",
            f"Activation distance of {row['file_name']}: {before['min_activation_distance']}-{before['max_activation_distance']} m "
            f"-> {payload.min_activation_distance}-{payload.max_activation_distance} m (written into the recording file)",
            None, [], {"activation_distance": before},
            extra={"recording": row["file_name"], "after": {"activation_distance": {
                "min_activation_distance": payload.min_activation_distance,
                "max_activation_distance": payload.max_activation_distance}}},
        )
        return result
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
