from __future__ import annotations

import functools
import gc
import json
import math
import re
import threading
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd
from statsmodels.stats.anova import AnovaRM

from .annotations import annotation_key, get_annotation, load_annotations
from .inclusion import load_inclusion
from .manual_discovery import get_manual_discovery_override
from .phase_overrides import load_phase_overrides
from .recording_pins import load_recording_pins, pin_key
from .route_overrides import actual_route
from .stats_exclusions import load_stats_exclusions
from .target_coordinates import get_target_coordinates, protocol_landmark_coordinates
from .task_split import load_task_splits
from .settings import get_settings

settings = get_settings()

_compute_lock = threading.RLock()


def _serialized(cached_fn):
    """Put on top of @lru_cache: lru_cache doesn't lock, so the page's
    parallel requests would each compute the same uncached value at once."""
    @functools.wraps(cached_fn)
    def wrapper(*args, **kwargs):
        with _compute_lock:
            return cached_fn(*args, **kwargs)
    wrapper.cache_clear = cached_fn.cache_clear
    return wrapper

IGNORE_FILENAMES = {"_summary.json"}
FILENAME_RE = re.compile(
    r"(?P<patient>pp_\d+)_"
    r"(?P<date>\d{4}-\d{2}-\d{2})_"
    r"(?P<time>\d{2}_\d{2}_\d{2}(?:\.\d+)?)_"
    r"(?P<phase>learning|exploration)_"
    r"(?P<condition>.+?)_"
    r"(?P<path_id>path_[A-Za-z0-9]+)\.json$"
)


def pretty_condition(condition: str | None) -> str:
    if condition is None:
        return "unknown"
    return str(condition).replace("_intes", "_intensity").replace("_", " ")


def folder_to_patient_name(folder: Path) -> str:
    name = folder.name
    if name.endswith("_sessions"):
        return name[: -len("_sessions")]
    match = re.search(r"(pp_\d+)", name)
    return match.group(1) if match else name


def parse_filename(path: Path) -> Dict[str, Any]:
    match = FILENAME_RE.match(path.name)
    if not match:
        return {}
    info = match.groupdict()
    info["start_time_from_filename"] = f"{info['date']} {info['time'].replace('_', ':')}"
    return info


@lru_cache(maxsize=512)
def load_json_cached(path_str: str) -> Dict[str, Any]:
    path = Path(path_str)
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def clear_derived_caches() -> None:
    """Invalidate only the dataset-wide DERIVED aggregates (ANOVA, speed/
    accel correlations) — NOT the expensive per-trial trajectory-comparison
    caches below (load_trial_metrics etc.), which stay valid since they
    depend only on the raw recorded x/y/z trajectories, never on
    annotations/manual coordinates/discovery overrides/patient inclusion.

    Call this (instead of clear_caches) after any save that can change which
    trials count or how they're valued — annotation, target coordinate,
    manual discovery override, patient inclusion — so General
    statistics/ANOVA reflect it on the very next request. Cheap: the
    expensive geometry work underneath is already cached and doesn't need
    to be redone, unlike a full /api/refresh.
    """
    compute_speed_accel_correlations.cache_clear()
    compute_anova_results.cache_clear()
    get_pause_noise_threshold.cache_clear()


def clear_caches() -> None:
    gc.unfreeze()
    load_json_cached.cache_clear()
    _tracking_df_cached.cache_clear()
    load_task_segments.cache_clear()
    load_task_event_counts.cache_clear()
    load_pause_metrics.cache_clear()
    load_border_counts.cache_clear()
    load_landmark_zone_split.cache_clear()
    load_learning_approach_depth.cache_clear()
    build_sessions_index_cached.cache_clear()
    load_session_metrics.cache_clear()
    load_trial_metrics.cache_clear()
    load_exploration_movement_events.cache_clear()
    load_target_sensor_proximity.cache_clear()
    clear_derived_caches()


def discover_json_files(base_dir: Path) -> List[Tuple[Path, Optional[str]]]:
    base_dir = Path(base_dir).expanduser()
    if not base_dir.exists():
        raise FileNotFoundError(f"DATA_DIR non esiste: {base_dir}")

    patient_dirs = sorted([p for p in base_dir.glob(settings.patient_dir_pattern) if p.is_dir()])
    files: List[Tuple[Path, Optional[str]]] = []

    if patient_dirs:
        for pp_dir in patient_dirs:
            patient_hint = folder_to_patient_name(pp_dir)
            for fp in sorted(pp_dir.rglob("*.json")):
                if fp.name in IGNORE_FILENAMES:
                    continue
                files.append((fp, patient_hint))
    else:
        for fp in sorted(base_dir.rglob("pp_*.json")):
            if fp.name in IGNORE_FILENAMES:
                continue
            files.append((fp, None))
    return files


def _safe_get(d: Dict[str, Any], path: Iterable[Any], default=None):
    cur: Any = d
    for key in path:
        if isinstance(cur, dict):
            cur = cur.get(key, default)
        elif isinstance(cur, list) and isinstance(key, int) and 0 <= key < len(cur):
            cur = cur[key]
        else:
            return default
    return cur


def _parse_timestamp(value) -> pd.Timestamp:
    return pd.to_datetime(value, errors="coerce")


def _parse_timestamps(values: List[Any]) -> List[pd.Timestamp]:
    # One vectorized parse per session: a pd.to_datetime call per sample
    # re-guesses the format every time (~2 ms each) and dominated load time.
    raw = pd.Series(values, dtype=object)
    parsed = pd.to_datetime(raw, errors="coerce", format="ISO8601")
    unparsed = parsed.isna() & raw.notna()
    for idx in unparsed[unparsed].index:
        parsed[idx] = pd.to_datetime(raw[idx], errors="coerce")
    return list(parsed)


def _jsonable(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        if not np.isfinite(value):
            return None
        return float(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return value
    if isinstance(value, (pd.Timestamp,)):
        return None if pd.isna(value) else value.isoformat()
    if pd.isna(value) if not isinstance(value, (list, dict, tuple, set)) else False:
        return None
    return value


def df_records(df: pd.DataFrame, max_rows: Optional[int] = None) -> List[Dict[str, Any]]:
    if df is None or df.empty:
        return []
    out = df.copy()
    for col in out.columns:
        if pd.api.types.is_datetime64_any_dtype(out[col]):
            out[col] = out[col].dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    if max_rows is not None:
        out = out.head(max_rows)
    records = out.replace({np.nan: None, np.inf: None, -np.inf: None}).to_dict(orient="records")
    return [{k: _jsonable(v) for k, v in r.items()} for r in records]


def _evenly_spaced_df(df: pd.DataFrame, max_rows: int) -> pd.DataFrame:
    """Return up to max_rows rows while preserving first/last and temporal shape."""
    if df is None or df.empty or max_rows is None or max_rows <= 0 or len(df) <= max_rows:
        return df
    idx = np.linspace(0, len(df) - 1, num=max_rows, dtype=int)
    idx = np.unique(idx)
    return df.iloc[idx].copy()


def downsample_df(df: pd.DataFrame, max_points: Optional[int] = 2000, group_col: Optional[str] = None) -> pd.DataFrame:
    """Downsample only the data sent to the browser. Metrics are computed before this step."""
    if df is None or df.empty or max_points is None or max_points <= 0 or len(df) <= max_points:
        return df

    if group_col and group_col in df.columns:
        groups = list(df.groupby(group_col, dropna=False))
        per_group = max(50, int(max_points / max(1, len(groups))))
        return pd.concat([_evenly_spaced_df(g.sort_values('t_s') if 't_s' in g.columns else g, per_group) for _, g in groups], ignore_index=True)

    if 't_s' in df.columns:
        df = df.sort_values('t_s')
    return _evenly_spaced_df(df, int(max_points))


def session_status_from_raw(raw_data: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not raw_data:
        return {
            "last_state": None,
            "status": "empty",
            "is_interrupt": False,
            "duration_s": np.nan,
            "is_suspicious_short": True,
            "warning": "⚠️ JSON senza raw_data",
        }

    first_ts = _parse_timestamp(raw_data[0].get("timestamp"))
    last_ts = _parse_timestamp(raw_data[-1].get("timestamp"))
    duration_s = (last_ts - first_ts).total_seconds() if pd.notna(first_ts) and pd.notna(last_ts) else np.nan
    last_state = _safe_get(raw_data[-1], ["activity_data", "state"])

    try:
        last_state_norm = int(last_state)
    except (TypeError, ValueError):
        last_state_norm = last_state

    is_interrupt = last_state_norm == settings.interrupt_state
    if last_state_norm == settings.completed_state:
        status = "completed"
    elif last_state_norm == settings.interrupt_state:
        status = "interrupt"
    elif last_state is None:
        status = "unknown"
    else:
        status = f"state_{last_state}"

    is_suspicious_short = False
    if pd.notna(duration_s) and duration_s < settings.min_duration_s:
        is_suspicious_short = True
    if len(raw_data) < settings.min_total_samples:
        is_suspicious_short = True

    warnings: List[str] = []
    if is_interrupt:
        warnings.append("⛔ INTERRUPT")
    if is_suspicious_short and not is_interrupt:
        warnings.append("⚠️ short/suspicious")
    if not warnings:
        warnings.append("✅ ok")

    return {
        "last_state": last_state_norm,
        "status": status,
        "is_interrupt": is_interrupt,
        "duration_s": duration_s,
        "is_suspicious_short": is_suspicious_short,
        "warning": " | ".join(warnings),
    }


@_serialized
@lru_cache(maxsize=4)
def build_sessions_index_cached(base_dir_str: str) -> pd.DataFrame:
    # Building the index parses every session's JSON into load_json_cached:
    # millions of long-lived objects. Left to the cyclic GC, each full pass
    # re-scans them all, which slowed this parse and made everything computed
    # afterwards ~20x slower — so pause it here and freeze them out of it.
    gc.disable()
    try:
        return build_sessions_index(Path(base_dir_str))
    finally:
        gc.freeze()
        gc.enable()


def build_sessions_index(base_dir: Path) -> pd.DataFrame:
    # Manual corrections for a session recorded under the wrong phase
    # (experimenter picked learning/exploration wrong at collection time) —
    # loaded once per index build, applied by file_name below. Since this
    # function is itself wrapped by build_sessions_index_cached, a correction
    # only takes effect after /api/refresh, same as adding/removing raw files.
    phase_overrides = load_phase_overrides()
    rows: List[Dict[str, Any]] = []
    for fp, patient_hint in discover_json_files(base_dir):
        filename_info = parse_filename(fp)
        try:
            data = load_json_cached(str(fp))
        except Exception as exc:
            rows.append({
                "patient": patient_hint or filename_info.get("patient") or "unknown",
                "phase": phase_overrides.get(fp.name, filename_info.get("phase")),
                "condition": filename_info.get("condition"),
                "path_id": filename_info.get("path_id"),
                "start_time": filename_info.get("start_time_from_filename"),
                "total_samples": np.nan,
                "n_raw": np.nan,
                "duration_s": np.nan,
                "last_state": None,
                "status": "load_error",
                "is_interrupt": False,
                "is_suspicious_short": True,
                "warning": f"❌ load error: {exc}",
                "file_path": str(fp),
                "file_name": fp.name,
            })
            continue

        raw = data.get("raw_data") or []
        status = session_status_from_raw(raw)
        patient = patient_hint or data.get("patient") or filename_info.get("patient") or "unknown"
        phase = phase_overrides.get(fp.name) or data.get("task") or filename_info.get("phase") or "unknown"
        condition = data.get("condition") or filename_info.get("condition") or "unknown"
        path_id = data.get("path_id") or filename_info.get("path_id") or "unknown"
        start_time = data.get("start_time") or filename_info.get("start_time_from_filename")

        rows.append({
            "patient": patient,
            "phase": phase,
            "condition": condition,
            "condition_label": pretty_condition(condition),
            "path_id": path_id,
            "start_time": start_time,
            "total_samples": data.get("total_samples", len(raw)),
            "n_raw": len(raw),
            "duration_s": status["duration_s"],
            "last_state": status["last_state"],
            "status": status["status"],
            "is_interrupt": status["is_interrupt"],
            "is_suspicious_short": status["is_suspicious_short"],
            "warning": status["warning"],
            "file_path": str(fp),
            "file_name": fp.name,
        })

    df = pd.DataFrame(rows)
    if df.empty:
        return df

    df["session_id"] = np.arange(len(df), dtype=int)
    df["start_time_dt"] = pd.to_datetime(df["start_time"], errors="coerce")
    df = df.sort_values(["patient", "condition", "path_id", "phase", "start_time_dt", "file_name"]).reset_index(drop=True)
    df["session_id"] = np.arange(len(df), dtype=int)
    return df


def get_sessions_df() -> pd.DataFrame:
    return build_sessions_index_cached(str(settings.data_dir.expanduser()))


def extract_config(data: Dict[str, Any]) -> Dict[str, Any]:
    first = (data.get("raw_data") or [{}])[0]
    params = _safe_get(first, ["metadata", "activity_cfg", "params"], default={}) or {}
    feedback_task = params.get("feedback_task", {}) or {}
    conditions = feedback_task.get("conditions", []) or []
    condition_cfg = conditions[0] if conditions else {}
    tags = params.get("tags", {}) or {}
    seeker_id = tags.get("seeker_id", "P1")
    target_ids = tags.get("hider_sequence_id") or ["O1", "O2", "O3"]
    distance_cfg = _safe_get(feedback_task, ["inputs", "distance"], default={}) or {}
    proximity_profiles = params.get("proximity_profiles", []) or []
    profiles_by_id = {p.get("id"): p for p in proximity_profiles if isinstance(p, dict)}
    anchors = _safe_get(first, ["metadata", "hardware_cfg", "anchors_cfg"], default=[]) or []
    return {
        "params": params,
        "feedback_task": feedback_task,
        "condition_cfg": condition_cfg,
        "seeker_id": seeker_id,
        "target_ids": list(target_ids),
        "distance_cfg": distance_cfg,
        "proximity_profiles": proximity_profiles,
        "profiles_by_id": profiles_by_id,
        "anchors": anchors,
    }


def save_activation_distance(
    session_id: int,
    min_activation_distance: float,
    max_activation_distance: float,
) -> Dict[str, Any]:
    """Overwrites min/max activation distance directly in the session's raw
    JSON file, on every raw_data entry that carries a distance block, so the
    file reads as if it had been recorded with this value from the start."""
    sessions_df = get_sessions_df()
    if session_id < 0 or session_id >= len(sessions_df):
        raise IndexError(f"session_id non valido: {session_id}")
    file_path = Path(sessions_df.iloc[int(session_id)]["file_path"])
    with file_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    updated = 0
    for entry in data.get("raw_data") or []:
        distance = _safe_get(entry, ["metadata", "activity_cfg", "params", "feedback_task", "inputs", "distance"])
        if isinstance(distance, dict):
            distance["min_activation_distance"] = min_activation_distance
            distance["max_activation_distance"] = max_activation_distance
            updated += 1

    with file_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    clear_caches()
    return {
        "min_activation_distance": min_activation_distance,
        "max_activation_distance": max_activation_distance,
        "updated_entries": updated,
    }


def config_to_profile_df(config: Dict[str, Any]) -> pd.DataFrame:
    selected_profile_ids = config.get("condition_cfg", {}).get("proximity_profiles", []) or []
    profiles_by_id = config.get("profiles_by_id", {}) or {}
    rows = []
    for profile_id in selected_profile_ids:
        p = profiles_by_id.get(profile_id)
        if p is None and isinstance(profile_id, str):
            p = profiles_by_id.get(profile_id.replace("intens", "intes"))
        if p is None:
            rows.append({
                "selected_profile_id": profile_id,
                "profile_id_found": None,
                "target_tags": None,
                "intensity_min": np.nan,
                "intensity_max": np.nan,
                "frequency_min": np.nan,
                "frequency_max": np.nan,
                "note": "profile id non trovato nei proximity_profiles",
            })
            continue
        rows.append({
            "selected_profile_id": profile_id,
            "profile_id_found": p.get("id"),
            "target_tags": ", ".join(p.get("target_tags", [])),
            "intensity_min": _safe_get(p, ["intensity", "min"]),
            "intensity_max": _safe_get(p, ["intensity", "max"]),
            "frequency_min": _safe_get(p, ["frequency_hz", "min"]),
            "frequency_max": _safe_get(p, ["frequency_hz", "max"]),
            "note": "",
        })
    return pd.DataFrame(rows)


def session_to_tracking_df(data: Dict[str, Any]) -> pd.DataFrame:
    rows = []
    raw_data = data.get("raw_data") or []
    timestamps = _parse_timestamps([rec.get("timestamp") for rec in raw_data])
    for sample_idx, rec in enumerate(raw_data):
        ts = timestamps[sample_idx]
        activity_data = rec.get("activity_data") or {}
        state = activity_data.get("state")
        event = activity_data.get("event")
        event_type = event.get("type") if isinstance(event, dict) else None
        for tag in activity_data.get("tags_data") or []:
            pos = list(tag.get("pos") or [np.nan, np.nan, np.nan])
            accel = list(tag.get("accel") or [np.nan, np.nan, np.nan])
            pos = pos + [np.nan] * (3 - len(pos))
            accel = accel + [np.nan] * (3 - len(accel))
            accel_vals = [float(v) for v in accel[:3] if pd.notna(v)]
            accel_norm = math.sqrt(sum(v**2 for v in accel_vals)) if accel_vals else np.nan
            rows.append({
                "sample_idx": sample_idx,
                "timestamp": ts,
                "state": state,
                "event_type": event_type,
                "tag_id": tag.get("id"),
                "x": pos[0], "y": pos[1], "z": pos[2],
                "ax": accel[0], "ay": accel[1], "az": accel[2],
                "accel_norm": accel_norm,
            })
    df = pd.DataFrame(rows)
    if not df.empty:
        t0 = df["timestamp"].min()
        df["t_s"] = (df["timestamp"] - t0).dt.total_seconds()
    return df


@_serialized
@lru_cache(maxsize=512)
def _tracking_df_cached(path_str: str) -> pd.DataFrame:
    return session_to_tracking_df(load_json_cached(path_str))


def load_tracking_df(file_path: Any) -> pd.DataFrame:
    return _tracking_df_cached(str(file_path)).copy()


def session_to_orientation_df(data: Dict[str, Any]) -> pd.DataFrame:
    """Extract per-sample IMU quaternion yaw (heading) per tag.

    quat_array convention in the recordings is [x, y, z, w] (unit norm).
    Yaw is the rotation around the vertical axis, in degrees, in the same
    x/y frame as the positions.
    """
    rows = []
    raw_data = data.get("raw_data") or []
    timestamps = _parse_timestamps([rec.get("timestamp") for rec in raw_data])
    for sample_idx, rec in enumerate(raw_data):
        ts = timestamps[sample_idx]
        for tag in (rec.get("activity_data") or {}).get("tags_data") or []:
            quat = list(tag.get("quat_array") or [])
            if len(quat) != 4:
                continue
            x, y, z, w = (float(v) for v in quat)
            norm = math.sqrt(x * x + y * y + z * z + w * w)
            if norm < 0.5:  # all-zero quaternion → IMU not initialised
                yaw = roll = pitch = np.nan
                x = y = z = w = np.nan
            else:
                x, y, z, w = x / norm, y / norm, z / norm, w / norm
                yaw = math.degrees(math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z)))
                roll = math.degrees(math.atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y)))
                pitch = math.degrees(math.asin(max(-1.0, min(1.0, 2.0 * (w * y - z * x)))))
            rows.append({
                "sample_idx": sample_idx, "timestamp": ts, "tag_id": tag.get("id"),
                "yaw_deg": yaw, "roll_deg": roll, "pitch_deg": pitch,
                "qx": x, "qy": y, "qz": z, "qw": w,
            })
    df = pd.DataFrame(rows)
    if not df.empty:
        t0 = df["timestamp"].min()
        df["t_s"] = (df["timestamp"] - t0).dt.total_seconds()
    return df


def _circular_mean_deg(angles_deg: np.ndarray) -> float:
    rad = np.radians(angles_deg)
    return float(np.degrees(np.arctan2(np.nanmean(np.sin(rad)), np.nanmean(np.cos(rad)))))


def _circular_std_deg(angles_deg: np.ndarray) -> float:
    rad = np.radians(angles_deg)
    r = math.hypot(float(np.nanmean(np.sin(rad))), float(np.nanmean(np.cos(rad))))
    r = min(1.0, max(1e-9, r))
    return float(np.degrees(math.sqrt(-2.0 * math.log(r))))


def compute_imu_quality(
    tracking_df: pd.DataFrame,
    seeker_id: str,
    target_ids: List[str],
) -> Dict[str, Any]:
    """Flag probable physical impacts on the (stationary) target sensors.

    Target tags O1–O3 sit still, so their accel norm hovers near a small
    baseline; a sample far above baseline means the sensor was hit/kicked.
    """
    out: Dict[str, Any] = {"tags": [], "impacts": [], "impact_count": 0}
    if tracking_df.empty or "accel_norm" not in tracking_df.columns:
        return out

    for tag_id, g in tracking_df.groupby("tag_id", dropna=True):
        acc = pd.to_numeric(g["accel_norm"], errors="coerce").dropna()
        acc = acc[acc > 0]  # zeros = IMU not streaming
        if acc.empty:
            out["tags"].append({
                "tag_id": tag_id, "samples": 0, "median_accel": None,
                "p95_accel": None, "max_accel": None, "spike_count": 0, "is_target": tag_id in target_ids,
            })
            continue
        median = float(acc.median())
        p95 = float(acc.quantile(0.95))
        threshold = max(settings.impact_min_accel, median + settings.impact_delta_accel)
        spikes = g.loc[acc[acc > threshold].index] if tag_id in target_ids else g.iloc[0:0]
        out["tags"].append({
            "tag_id": tag_id,
            "samples": int(len(acc)),
            "median_accel": round(median, 3),
            "p95_accel": round(p95, 3),
            "max_accel": round(float(acc.max()), 3),
            "spike_count": int(len(spikes)),
            "threshold": round(threshold, 3),
            "is_target": tag_id in target_ids,
        })
        for _, r in spikes.iterrows():
            out["impacts"].append({
                "tag_id": tag_id,
                "t_s": _jsonable(r.get("t_s")),
                "accel_norm": round(float(r["accel_norm"]), 3),
            })

    out["impacts"].sort(key=lambda r: (r["t_s"] is None, r["t_s"]))

    # Consecutive spike samples belong to one physical hit: merge samples closer
    # than 1 s (per tag) into a single event, keeping the peak acceleration.
    events = merge_events(
        out["impacts"], time_key="t_s", group_key="tag_id", gap_s=1.0,
        value_key="accel_norm", value_out_key="peak_accel",
    )
    out["events"] = events
    out["impact_count"] = len(events)
    return out


def merge_events(
    items: List[Dict[str, Any]],
    time_key: str = "t_s",
    group_key: Optional[str] = None,
    gap_s: float = 1.0,
    value_key: Optional[str] = None,
    value_out_key: str = "peak",
) -> List[Dict[str, Any]]:
    """Merge consecutive items (matching on group_key, if given) that are at most
    gap_s apart in time_key into single start/end events, keeping the max of
    value_key (if given) as value_out_key on the merged event."""
    events: List[Dict[str, Any]] = []
    end_key = f"end_{time_key}"
    for item in items:
        t = item.get(time_key)
        if group_key is not None:
            prev = next((e for e in reversed(events) if e.get(group_key) == item.get(group_key)), None)
        else:
            prev = events[-1] if events else None
        if prev is not None and t is not None and prev.get(end_key) is not None and t - prev[end_key] <= gap_s:
            prev[end_key] = t
            if value_key is not None:
                prev[value_out_key] = max(prev[value_out_key], item.get(value_key))
        else:
            event: Dict[str, Any] = {}
            if group_key is not None:
                event[group_key] = item.get(group_key)
            event[time_key] = t
            event[end_key] = t
            if value_key is not None:
                event[value_out_key] = item.get(value_key)
            events.append(event)
    return events


def compute_orientation_consistency(
    tracking_df: pd.DataFrame,
    orientation_df: pd.DataFrame,
    seeker_id: str,
) -> Dict[str, Any]:
    """Compare IMU yaw with the walking direction derived from the 2D trajectory.

    A roughly constant offset means the IMU simply isn't aligned with the
    walking direction (mounting offset); a large spread means yaw and
    trajectory disagree and the arrow overlay should not be trusted.
    """
    out: Dict[str, Any] = {
        "samples_used": 0,
        "median_offset_deg": None,
        "circular_std_deg": None,
        "consistency": "unknown",
        "note": "Not enough valid IMU/trajectory data.",
    }
    if tracking_df.empty or orientation_df.empty:
        return out

    p1 = tracking_df[tracking_df["tag_id"] == seeker_id].sort_values("timestamp")
    yaw = orientation_df[orientation_df["tag_id"] == seeker_id].sort_values("timestamp")
    if p1.empty or yaw.empty:
        return out

    merged = p1[["timestamp", "t_s", "x", "y"]].merge(yaw[["timestamp", "yaw_deg"]], on="timestamp", how="inner")
    if len(merged) < 10:
        return out

    # Smooth positions before differencing: raw UWB jitter would randomise headings.
    win = 5
    merged["xs"] = merged["x"].rolling(win, min_periods=1, center=True).median()
    merged["ys"] = merged["y"].rolling(win, min_periods=1, center=True).median()
    merged["dx"] = merged["xs"].diff(win)
    merged["dy"] = merged["ys"].diff(win)
    merged["dt"] = merged["t_s"].diff(win)
    merged["step"] = np.hypot(merged["dx"], merged["dy"])
    merged["speed"] = merged["step"] / merged["dt"]
    moving = merged[(merged["speed"] > settings.heading_min_speed) & merged["yaw_deg"].notna()].copy()
    if len(moving) < 10:
        out["note"] = "Seeker rarely moved fast enough to estimate walking direction."
        return out

    moving["heading_deg"] = np.degrees(np.arctan2(moving["dy"], moving["dx"]))
    diff = (moving["yaw_deg"] - moving["heading_deg"] + 180.0) % 360.0 - 180.0
    offset = _circular_mean_deg(diff.to_numpy())
    residual = (diff - offset + 180.0) % 360.0 - 180.0
    spread = _circular_std_deg(residual.to_numpy())

    if spread < 30:
        consistency = "good"
        note = "IMU yaw tracks the walking direction (constant mounting offset removed)."
    elif spread < 60:
        consistency = "fair"
        note = "IMU yaw only loosely follows the walking direction; treat the arrow as indicative."
    else:
        consistency = "poor"
        note = "IMU yaw does not match the trajectory; the sensor was probably not aligned with the walking direction."

    out.update({
        "samples_used": int(len(moving)),
        "median_offset_deg": round(offset, 1),
        "circular_std_deg": round(spread, 1),
        "consistency": consistency,
        "note": note,
    })
    return out


def p1_xy(tracking_df: pd.DataFrame, seeker_id: str) -> pd.DataFrame:
    """Seeker's own 2D trajectory (z is frequently NaN, so this stays 2D)."""
    if tracking_df is None or tracking_df.empty:
        return pd.DataFrame(columns=["timestamp", "t_s", "x", "y"])
    cols = [c for c in ["timestamp", "t_s", "x", "y"] if c in tracking_df.columns]
    p1 = tracking_df.loc[tracking_df["tag_id"] == seeker_id, cols].dropna(subset=["x", "y"])
    return p1.sort_values("timestamp").reset_index(drop=True)


def resample_by_arc_length(xy_df: pd.DataFrame, step_m: float) -> pd.DataFrame:
    """Light median-smooth the path, then resample it at a fixed arc-length step
    so trajectories with different sampling rates/durations become comparable."""
    if xy_df is None or len(xy_df) < 2:
        return pd.DataFrame(columns=["s_m", "x", "y"])
    xs = xy_df["x"].astype(float).rolling(7, center=True, min_periods=1).median().to_numpy()
    ys = xy_df["y"].astype(float).rolling(7, center=True, min_periods=1).median().to_numpy()
    d = np.hypot(np.diff(xs), np.diff(ys))
    s = np.concatenate([[0.0], np.cumsum(d)])
    total_len = float(s[-1])
    if total_len < step_m:
        return pd.DataFrame(columns=["s_m", "x", "y"])
    new_s = np.arange(0.0, total_len, step_m)
    return pd.DataFrame({"s_m": new_s, "x": np.interp(new_s, s, xs), "y": np.interp(new_s, s, ys)})


def _heading_change_deg(resampled: pd.DataFrame, step_m: float) -> np.ndarray:
    """Absolute heading change (deg) over a ~0.9 m symmetric window, one value per
    consecutive-point heading (i.e. length len(resampled) - 1), aligned to resampled.index."""
    if resampled is None or len(resampled) < 3:
        return np.array([])
    x = resampled["x"].to_numpy()
    y = resampled["y"].to_numpy()
    heading = np.degrees(np.arctan2(np.diff(y), np.diff(x)))
    heading_unwrapped = np.degrees(np.unwrap(np.radians(heading)))
    heading_smooth = pd.Series(heading_unwrapped).rolling(5, center=True, min_periods=1).mean().to_numpy()
    win = max(1, int(round(0.45 / step_m)))
    n = len(heading_smooth)
    if n <= 2 * win:
        return np.zeros(n)
    change = np.zeros(n)
    change[win:n - win] = np.abs(heading_smooth[2 * win:] - heading_smooth[:n - 2 * win])
    return change


def target_tag_positions(tracking_df: pd.DataFrame, target_ids: List[str]) -> Dict[str, Tuple[float, float]]:
    """Median (x, y) of each target tag's own tracked position — the targets
    are stationary physical objects, so this is their real placement in the
    room for this trial. Empty for any target_id this condition never tracked
    (e.g. haptic_on_object_intes tracked only the seeker P1)."""
    positions: Dict[str, Tuple[float, float]] = {}
    for tid in target_ids:
        rows = tracking_df[(tracking_df["tag_id"] == tid) & tracking_df["x"].notna() & tracking_df["y"].notna()]
        if rows.empty:
            continue
        positions[tid] = (float(rows["x"].median()), float(rows["y"].median()))
    return positions


IDEAL_TURN_ANGLE_DEG = 90.0


def canonical_turn_angles(
    waypoints_in_order: List[Tuple[str, Tuple[float, float]]]
) -> List[Dict[str, Any]]:
    """The reference turn angle at each target is no longer measured from the
    (noisy) recorded learning trajectory, and not even the geometric angle of
    the real tracked positions — it's a flat IDEAL_TURN_ANGLE_DEG (90°), the
    path's own design intent (confirmed by the researcher: every turn is a
    right angle by construction; any deviation the real geometry would show
    is itself just imprecision in the tracked target position, not a
    different intended angle). Turn LOCATIONS still come from the real
    tracked positions, in intended visit order — only the reference angle at
    each one is now fixed. This is immune to the walking noise, pauses, and
    confused backtracking that made measuring the angle from the learning
    trajectory's own shape unreliable (a person pausing or circling right at
    a target could make that specific measurement read anywhere from ~0° to
    over 300°).
    waypoints_in_order: [("start", xy), ("O1", xy), ("O2", xy), ("O3", xy), ("stop", xy)]
    (fewer target waypoints if this condition didn't track all of them).
    Returns one entry per INTERIOR waypoint (i.e. per target, not start/stop)."""
    turns = []
    for i in range(1, len(waypoints_in_order) - 1):
        target_id, p_cur = waypoints_in_order[i]
        change = IDEAL_TURN_ANGLE_DEG
        turns.append({
            "turn_index": i - 1,
            "target_id": target_id,
            "x": float(p_cur[0]),
            "y": float(p_cur[1]),
            "heading_change_deg": float(change),
        })
    return turns


def heading_change_near_point(xy_df: pd.DataFrame, point_xy: Tuple[float, float], radius_m: float) -> Optional[float]:
    """Heading change of xy_df's own trajectory at the point nearest to point_xy, or
    None if the trajectory never comes within radius_m of it (turn never visited)."""
    step_m = settings.turn_resample_step_m
    resampled = resample_by_arc_length(xy_df, step_m)
    change = _heading_change_deg(resampled, step_m)
    if len(change) == 0:
        return None
    xs = resampled["x"].to_numpy()[: len(change)]
    ys = resampled["y"].to_numpy()[: len(change)]
    dists = np.hypot(xs - point_xy[0], ys - point_xy[1])
    idx = int(np.argmin(dists))
    if dists[idx] > radius_m:
        return None
    return float(change[idx])


def compute_room_bbox(anchors_cfg: List[Dict[str, Any]]) -> Optional[Dict[str, float]]:
    xs, ys = [], []
    for a in anchors_cfg or []:
        coords = a.get("coords") if isinstance(a, dict) else None
        if coords and len(coords) >= 2:
            xs.append(coords[0])
            ys.append(coords[1])
    if not xs or not ys:
        return None
    return {"x_min": float(min(xs)), "x_max": float(max(xs)), "y_min": float(min(ys)), "y_max": float(max(ys))}


def compute_stop_events(speed_df: pd.DataFrame) -> Dict[str, Any]:
    if speed_df is None or speed_df.empty or "speed_m_s_smooth" not in speed_df.columns:
        return {"count": 0, "events": []}
    slow = speed_df[pd.to_numeric(speed_df["speed_m_s_smooth"], errors="coerce") < settings.stop_speed_threshold_m_s]
    items = [{"t_s": float(t)} for t in slow["t_s"].dropna().sort_values().to_numpy()]
    events = merge_events(items, time_key="t_s", gap_s=0.3)
    events = [e for e in events if (e["end_t_s"] - e["t_s"]) >= settings.stop_min_duration_s]
    return {"count": len(events), "events": events}


# ---------------------------------------------------------------------------
# Pauses of the hand-held unit P1 — the rule used by the dashboard.
# compute_stop_events above is the previous rule, kept for comparison only.
# ---------------------------------------------------------------------------

def _position_segments(tag_df: pd.DataFrame) -> Tuple[List[Tuple[np.ndarray, np.ndarray, np.ndarray]], List[Tuple[float, float]]]:
    """One tag's samples split into the stretches where its position keeps
    updating, and the data gaps between them.

    Samples whose (x, y) repeat the previous sample are dropped first: the
    position updates less often than the 10 Hz recording, so a repeated value
    is not a new measurement. A gap is a stretch where the position stays
    identical for at least data_gap_min_duration_s (between two consecutive
    remaining samples, or from the last one to the end of the recording); the
    stretches on either side are handled separately.
    """
    g = tag_df[["t_s", "x", "y"]].apply(pd.to_numeric, errors="coerce").dropna().sort_values("t_s")
    if g.empty:
        return [], []
    t_end = float(g["t_s"].iloc[-1])
    repeated = (g["x"].diff() == 0) & (g["y"].diff() == 0)
    g = g[~repeated]
    t, x, y = g["t_s"].to_numpy(), g["x"].to_numpy(), g["y"].to_numpy()
    gap_min = settings.data_gap_min_duration_s
    breaks = np.where(np.diff(t) >= gap_min)[0]
    gaps = [(float(t[i]), float(t[i + 1])) for i in breaks]
    if t_end - t[-1] >= gap_min:
        gaps.append((float(t[-1]), t_end))
    bounds = [0, *(breaks + 1), len(t)]
    segments = [(t[a:b], x[a:b], y[a:b]) for a, b in zip(bounds[:-1], bounds[1:]) if b > a]
    return segments, gaps


def _window_speed(t: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Speed at each sample: horizontal displacement between the samples at
    t - window/2 and t + window/2 (the nearest ones inside the stretch),
    divided by the real time between those two samples."""
    half = settings.pause_window_s / 2.0
    n = len(t)
    ia = np.clip(np.searchsorted(t, t - half, side="right") - 1, 0, n - 1)
    ib = np.clip(np.searchsorted(t, t + half, side="left"), 0, n - 1)
    dt = t[ib] - t[ia]
    with np.errstate(divide="ignore", invalid="ignore"):
        speed = np.hypot(x[ib] - x[ia], y[ib] - y[ia]) / dt
    speed[dt <= 0] = np.nan
    return speed


def tag_window_speeds(tag_df: pd.DataFrame) -> Tuple[List[Tuple[np.ndarray, np.ndarray]], List[Tuple[float, float]]]:
    """(time, speed) per stretch of one tag, plus its data gaps."""
    segments, gaps = _position_segments(tag_df)
    return [(t, _window_speed(t, x, y)) for t, x, y in segments], gaps


def _share_by_task(intervals: List[Tuple[float, float]], split_t_s: Optional[float]) -> Dict[str, Any]:
    """Count and total duration of time intervals, whole and per task. An
    interval counts in the task where it starts; its duration is shared
    between the tasks by the time it spends in each."""
    out: Dict[str, Any] = {"count": len(intervals), "duration_s": float(sum(b - a for a, b in intervals))}
    if split_t_s is None:
        out.update({"task1_count": None, "task2_count": None, "task1_duration_s": None, "task2_duration_s": None})
        return out
    out["task1_count"] = sum(1 for a, _ in intervals if a <= split_t_s)
    out["task2_count"] = len(intervals) - out["task1_count"]
    out["task1_duration_s"] = float(sum(max(0.0, min(b, split_t_s) - a) for a, b in intervals))
    out["task2_duration_s"] = float(sum(max(0.0, b - max(a, split_t_s)) for a, b in intervals))
    return out


def compute_pause_events(
    tracking_df: pd.DataFrame,
    seeker_id: str,
    split_t_s: Optional[float],
    noise_threshold_m_s: float,
    relative_fraction: Optional[float] = None,
) -> Dict[str, Any]:
    """Pauses of the hand-held unit P1 (only P1: the landmark units serve only
    to estimate the noise threshold).

    P1 is paused while its window speed (_window_speed) stays below the
    threshold for at least pause_min_duration_s. The threshold is the noise
    threshold, or — with relative_fraction — the higher of the noise threshold
    and relative_fraction × P1's median speed in that task (task 1 up to the
    marked time, task 2 after; the whole recording when it has no marked
    time), the median taken on the moving samples only (at or above the noise
    threshold). Data gaps (position frozen for data_gap_min_duration_s or
    more) split the stretches and are never pauses: they are reported apart.
    """
    p1 = tracking_df[tracking_df["tag_id"] == seeker_id] if tracking_df is not None and not tracking_df.empty else pd.DataFrame()
    stretches, gaps = tag_window_speeds(p1) if not p1.empty else ([], [])

    def task_mask(t: np.ndarray, task: Optional[int]) -> np.ndarray:
        if task is None or split_t_s is None:
            return np.ones(len(t), dtype=bool)
        return t <= split_t_s if task == 1 else t > split_t_s

    thresholds: Dict[str, float] = {}
    tasks = [None] if split_t_s is None else [1, 2]
    for task in tasks:
        thr = float(noise_threshold_m_s)
        if relative_fraction is not None and stretches:
            v = np.concatenate([sp[task_mask(t, task)] for t, sp in stretches])
            moving = v[np.isfinite(v) & (v >= noise_threshold_m_s)]
            if moving.size:
                thr = max(thr, float(relative_fraction) * float(np.median(moving)))
        thresholds["whole" if task is None else f"task{task}"] = thr

    pauses: List[Tuple[float, float]] = []
    for t, sp in stretches:
        thr = np.full(len(t), thresholds.get("whole", np.nan))
        if split_t_s is not None:
            thr = np.where(t <= split_t_s, thresholds["task1"], thresholds["task2"])
        below = np.isfinite(sp) & (sp < thr)
        i, n = 0, len(t)
        while i < n:
            if not below[i]:
                i += 1
                continue
            j = i
            while j + 1 < n and below[j + 1]:
                j += 1
            if t[j] - t[i] >= settings.pause_min_duration_s:
                pauses.append((float(t[i]), float(t[j])))
            i = j + 1

    return {
        "pauses": pauses,
        "gaps": gaps,
        "thresholds_m_s": thresholds,
        "pause": _share_by_task(pauses, split_t_s),
        "gap": _share_by_task(gaps, split_t_s),
    }


LANDMARK_ZONE_KEYS = (
    "task1_time_near_landmarks_s", "task1_time_away_landmarks_s",
    "task1_speed_near_landmarks_m_s", "task1_speed_away_landmarks_m_s",
    "task1_intensity_near_landmarks_m_s2", "task1_intensity_away_landmarks_m_s2",
)


@_serialized
@lru_cache(maxsize=4096)
def load_landmark_zone_split(session_id: int, split_t_s: Optional[float]) -> Dict[str, Optional[float]]:
    """Task 1 of one recording (up to the marked time) split into the time P1
    spends near the landmarks (within landmark_near_radius_m of any of them,
    horizontal distance) and away from them, with the speed in each part
    (path length / time). A step between two samples belongs to the part of
    its earlier sample. Landmark positions: the median position of each
    landmark unit in this recording; for haptic_on_object the route's
    protocol positions (PROTOCOL_LANDMARKS), since the units were parked at
    the border there. All None without a marked time.

    Movement intensity near / away: mean norm of P1's linear acceleration
    over the samples near / away, samples at zero (IMU not streaming) left
    out — same rule as movement_intensity_m_s2."""
    out: Dict[str, Optional[float]] = {k: None for k in LANDMARK_ZONE_KEYS}
    if split_t_s is None:
        return out
    row = get_sessions_df().iloc[int(session_id)]
    config = extract_config(load_json_cached(str(row["file_path"])))
    tracking_df = load_tracking_df(row["file_path"])
    if _condition_factors(row["condition"]) == ("haptic", "on_object"):
        route = actual_route(str(row["patient"]), str(row["condition"]), str(row["path_id"]))
        landmarks = list(protocol_landmark_coordinates(route, config["target_ids"]).values())
    else:
        landmarks = []
        for tid in config["target_ids"]:
            g = tracking_df.loc[tracking_df["tag_id"] == tid, ["x", "y"]].apply(pd.to_numeric, errors="coerce").dropna()
            if not g.empty:
                landmarks.append([float(g["x"].median()), float(g["y"].median())])
    xy = p1_xy(tracking_df, config["seeker_id"])
    xy = xy[xy["t_s"] <= split_t_s].sort_values("t_s")
    if not landmarks or len(xy) < 2:
        return out
    t, x, y = xy["t_s"].to_numpy(), xy["x"].to_numpy(), xy["y"].to_numpy()
    lm = np.array(landmarks, dtype=float)
    near = np.hypot(x[:, None] - lm[None, :, 0], y[:, None] - lm[None, :, 1]).min(axis=1) <= settings.landmark_near_radius_m
    dt = np.diff(t)
    step = np.hypot(np.diff(x), np.diff(y))
    for name, mask in (("near", near[:-1]), ("away", ~near[:-1])):
        time_s = float(dt[mask].sum())
        out[f"task1_time_{name}_landmarks_s"] = time_s
        out[f"task1_speed_{name}_landmarks_m_s"] = float(step[mask].sum() / time_s) if time_s > 0 else None

    if "accel_norm" in tracking_df.columns:
        acc = tracking_df.loc[tracking_df["tag_id"] == config["seeker_id"], ["t_s", "x", "y", "accel_norm"]]
        acc = acc.apply(pd.to_numeric, errors="coerce").dropna()
        acc = acc[(acc["t_s"] <= split_t_s) & (acc["accel_norm"] > 0)]  # zeros = IMU not streaming
        if not acc.empty:
            acc_near = np.hypot(
                acc["x"].to_numpy()[:, None] - lm[None, :, 0], acc["y"].to_numpy()[:, None] - lm[None, :, 1]
            ).min(axis=1) <= settings.landmark_near_radius_m
            a_norm = acc["accel_norm"].to_numpy()
            for name, mask in (("near", acc_near), ("away", ~acc_near)):
                out[f"task1_intensity_{name}_landmarks_m_s2"] = float(a_norm[mask].mean()) if mask.any() else None
    return out


@_serialized
@lru_cache(maxsize=4096)
def load_learning_approach_depth(session_id: int, split_t_s: Optional[float]) -> Dict[str, Any]:
    """Approach depth of a LEARNING recording, task 1, computed like the
    experimental one: from the feedback steps up to the marked time, or —
    for haptic_on_object — from P1's position against the route's protocol
    landmark positions (compute_approach_depth_from_positions)."""
    if split_t_s is None:
        return _approach_depth_summary({})
    row = get_sessions_df().iloc[int(session_id)]
    data = load_json_cached(str(row["file_path"]))
    config = extract_config(data)
    if _condition_factors(row["condition"]) == ("haptic", "on_object"):
        xy = p1_xy(load_tracking_df(row["file_path"]), config["seeker_id"])
        route = actual_route(str(row["patient"]), str(row["condition"]), str(row["path_id"]))
        coords = protocol_landmark_coordinates(route, config["target_ids"])
        return compute_approach_depth_from_positions(xy[xy["t_s"] <= split_t_s], coords, config["distance_cfg"])
    feedback_df = session_to_feedback_df(data)
    if not feedback_df.empty:
        feedback_df = feedback_df[feedback_df["t_s"] <= split_t_s]
    return compute_approach_depth(feedback_df, config["distance_cfg"])


def compute_stay_point_pauses(
    tracking_df: pd.DataFrame, seeker_id: str, split_t_s: Optional[float],
    radius_m: float, min_duration_s: float,
) -> Dict[str, Any]:
    """Pauses of P1 as stay points (Li et al. 2008, Mining user similarity
    based on location history, ACM SIGSPATIAL GIS, doi:10.1145/1463434.1463477).

    P1's samples go through _position_segments (repeated positions dropped,
    stretches split at data gaps; data gaps are never pauses). Within each
    stretch: from sample i, extend j while every next sample stays within
    radius_m of sample i; if t[j] - t[i] >= min_duration_s, (t[i], t[j]) is a
    pause and the scan restarts at j + 1, otherwise at i + 1. Pauses and gaps
    are shared between the tasks like in compute_pause_events.
    compute_pause_events (window speed below a noise threshold) is the
    previous rule, kept for comparison only.

    The stillness at the very start and end of a recording is not counted: a
    pause starting at the first sample of the first stretch is the wait
    between Start and the participant walking off, and one ending at the last
    sample of the last stretch is the wait before the operator pressed Stop.
    Both describe the operator, not the walk ("edge_pauses" lists them).
    """
    p1 = tracking_df[tracking_df["tag_id"] == seeker_id] if tracking_df is not None and not tracking_df.empty else pd.DataFrame()
    segments, gaps = _position_segments(p1) if not p1.empty else ([], [])
    pauses: List[Tuple[float, float]] = []
    for t, x, y in segments:
        n, i = len(t), 0
        while i < n:
            j = i
            while j + 1 < n and math.hypot(x[j + 1] - x[i], y[j + 1] - y[i]) <= radius_m:
                j += 1
            if t[j] - t[i] >= min_duration_s:
                pauses.append((float(t[i]), float(t[j])))
                i = j + 1
            else:
                i += 1
    edge_pauses: List[Tuple[float, float]] = []
    if segments and pauses:
        first_t, last_t = float(segments[0][0][0]), float(segments[-1][0][-1])
        edge_pauses = [p for p in pauses if p[0] == first_t or p[1] == last_t]
        pauses = [p for p in pauses if not (p[0] == first_t or p[1] == last_t)]
    return {
        "pauses": pauses,
        "edge_pauses": edge_pauses,
        "gaps": gaps,
        "pause": _share_by_task(pauses, split_t_s),
        "gap": _share_by_task(gaps, split_t_s),
    }


PAUSE_METRIC_KEYS = tuple(
    f"{scope}{kind}_{measure}"
    for scope in ("", "task1_", "task2_")
    for kind in ("pause", "data_gap")
    for measure in ("count", "duration_s")
)


@_serialized
@lru_cache(maxsize=4096)
def load_pause_metrics(
    session_id: int, split_t_s: Optional[float], radius_m: float, min_duration_s: float,
) -> Dict[str, Any]:
    """Pause (stay points, compute_stay_point_pauses) and data-gap count and
    duration of P1 for one recording, whole and per task (PAUSE_METRIC_KEYS),
    cached. The rule settings are arguments so a change is never served from
    the cache."""
    row = get_sessions_df().iloc[int(session_id)]
    config = extract_config(load_json_cached(str(row["file_path"])))
    res = compute_stay_point_pauses(load_tracking_df(row["file_path"]), config["seeker_id"], split_t_s, radius_m, min_duration_s)
    out: Dict[str, Any] = {}
    for kind, key in (("pause", "pause"), ("data_gap", "gap")):
        for scope in ("", "task1_", "task2_"):
            for measure in ("count", "duration_s"):
                out[f"{scope}{kind}_{measure}"] = res[key][f"{scope}{measure}"]
    return out


def _analysis_recordings() -> List[Dict[str, Any]]:
    """The recordings included in the analysis: those of included
    participants, not flagged as too short, and not part of a trial excluded
    from the statistics (both the excluded exploration attempt and its
    learning reference)."""
    sessions_df = get_sessions_df()
    if sessions_df.empty:
        return []
    inclusion = load_inclusion()
    excluded: set = set()
    trials_df = build_trials_df()
    for _, r in trials_df.iterrows():
        exp_id = int(r["exploration_session_id"]) if pd.notna(r["exploration_session_id"]) else None
        if get_annotation(r["patient"], r["condition"], r["path_id"], exp_id).get("excluded_from_stats"):
            if exp_id is not None:
                excluded.add(exp_id)
            if pd.notna(r["learning_session_id"]):
                excluded.add(int(r["learning_session_id"]))
    out = []
    for _, row in sessions_df.iterrows():
        if inclusion.get(row["patient"], True) is False or bool(row.get("is_suspicious_short")) or int(row["session_id"]) in excluded:
            continue
        out.append(row.to_dict())
    return out


def _noise_signature(recordings: List[Dict[str, Any]]) -> str:
    import hashlib
    h = hashlib.sha1()
    h.update(f"{settings.pause_window_s}|{settings.pause_noise_percentile}|{settings.data_gap_min_duration_s}".encode())
    for r in sorted(recordings, key=lambda r: r["file_name"]):
        try:
            st = Path(r["file_path"]).stat()
            h.update(f"{r['file_name']}|{st.st_size}|{int(st.st_mtime)}|{r.get('phase')}".encode())
        except OSError:
            h.update(str(r["file_name"]).encode())
    return h.hexdigest()


def compute_pause_noise_threshold(recordings: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Position-noise threshold for the pauses, from the landmark units O1-O3,
    which stay still: their window speed (same method as P1) is only noise.
    Outside haptic_on_object (units parked at the border there), on every
    recording included in the analysis. The threshold is the
    pause_noise_percentile of all their samples."""
    recordings = _analysis_recordings() if recordings is None else recordings
    speeds: List[np.ndarray] = []
    used = 0
    for r in recordings:
        if str(r.get("condition") or "").startswith("haptic_on_object"):
            continue
        try:
            config = extract_config(load_json_cached(str(r["file_path"])))
            tracking_df = load_tracking_df(r["file_path"])
        except Exception:
            continue
        got = False
        for tid in config["target_ids"]:
            stretches, _ = tag_window_speeds(tracking_df[tracking_df["tag_id"] == tid])
            for _, sp in stretches:
                sp = sp[np.isfinite(sp)]
                if sp.size:
                    speeds.append(sp)
                    got = True
        used += int(got)
    v = np.concatenate(speeds) if speeds else np.array([])
    pct = settings.pause_noise_percentile
    return {
        "value_m_s": float(np.percentile(v, pct)) if v.size else None,
        "percentile": pct,
        "median_m_s": float(np.median(v)) if v.size else None,
        "p90_m_s": float(np.percentile(v, 90)) if v.size else None,
        "p95_m_s": float(np.percentile(v, 95)) if v.size else None,
        "n_recordings": used,
        "n_samples": int(v.size),
        "method": (
            f"{pct:g}th percentile of the window speed (horizontal displacement over "
            f"{settings.pause_window_s:g} s, repeated positions dropped, data gaps of "
            f"{settings.data_gap_min_duration_s:g} s or more split) of the still landmark "
            "units O1-O3, outside haptic_on_object, on every recording included in the analysis"
        ),
    }


@lru_cache(maxsize=1)
def get_pause_noise_threshold() -> Dict[str, Any]:
    """The stored noise threshold (pause_noise_threshold_path), computed again
    and saved when the recordings, inclusions, exclusions or the method
    settings have changed since it was stored."""
    recordings = _analysis_recordings()
    signature = _noise_signature(recordings)
    path = settings.pause_noise_threshold_path
    try:
        stored = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    except Exception:
        stored = None
    if stored and stored.get("signature") == signature and stored.get("value_m_s") is not None:
        return stored
    result = compute_pause_noise_threshold(recordings)
    result["signature"] = signature
    result["computed_at"] = pd.Timestamp.now().isoformat(timespec="seconds")
    try:
        path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    except OSError:
        pass
    return result


def pause_settings() -> Tuple[float, Optional[float]]:
    """(noise threshold, relative fraction or None) of the previous pause rule
    (compute_pause_events), kept for comparison only: the pauses now use
    stay points (compute_stay_point_pauses)."""
    noise = get_pause_noise_threshold().get("value_m_s")
    noise = float(noise) if noise is not None else settings.stop_speed_threshold_m_s
    fraction = settings.pause_relative_fraction if settings.pause_relative_enabled else None
    return noise, fraction


def _border_inner_box(bbox: Dict[str, float]) -> Dict[str, float]:
    x_span = bbox["x_max"] - bbox["x_min"]
    y_span = bbox["y_max"] - bbox["y_min"]
    # Longer anchor-span axis gets the larger margin (e.g. 12 m axis -> 8 m inner span);
    # a square room (tie) falls back to treating y as the long axis.
    if x_span > y_span:
        margin_x, margin_y = settings.border_margin_long_m, settings.border_margin_short_m
    else:
        margin_x, margin_y = settings.border_margin_short_m, settings.border_margin_long_m
    return {
        "x_min": bbox["x_min"] + margin_x, "x_max": bbox["x_max"] - margin_x,
        "y_min": bbox["y_min"] + margin_y, "y_max": bbox["y_max"] - margin_y,
    }


def _border_p1(tracking_df: pd.DataFrame, seeker_id: str) -> pd.DataFrame:
    return tracking_df.loc[tracking_df["tag_id"] == seeker_id, ["t_s", "x", "y"]].dropna(subset=["x", "y"]).sort_values("t_s")


def compute_border_events(tracking_df: pd.DataFrame, seeker_id: str, bbox: Optional[Dict[str, float]]) -> Dict[str, Any]:
    """Border crossings of P1 with a spatial hysteresis of border_hysteresis_m.

    d_out = signed distance outside the inner box (positive outside,
    negative inside). A crossing starts when d_out > +h; the next one can only
    start after P1 has come back with d_out < -h. Each event keeps t_s (start)
    and end_t_s (first sample back below -h, or the last sample). count =
    number of starts. The previous rule (0.3 s merge) is
    compute_border_events_merge, kept for comparison only.
    """
    if not bbox or tracking_df is None or tracking_df.empty:
        return {"count": 0, "events": [], "inner_box": None}
    p1 = _border_p1(tracking_df, seeker_id)
    if p1.empty:
        return {"count": 0, "events": [], "inner_box": None}
    inner = _border_inner_box(bbox)
    x, y, t = p1["x"].to_numpy(dtype=float), p1["y"].to_numpy(dtype=float), p1["t_s"].to_numpy(dtype=float)
    d_out = np.max(np.stack([inner["x_min"] - x, x - inner["x_max"], inner["y_min"] - y, y - inner["y_max"]]), axis=0)
    h = settings.border_hysteresis_m
    events: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for ti, di in zip(t, d_out):
        if current is None:
            if di > h:
                current = {"t_s": float(ti), "end_t_s": float(ti)}
                events.append(current)
        elif di < -h:
            current["end_t_s"] = float(ti)
            current = None
    if current is not None:
        current["end_t_s"] = float(t[-1])
    return {"count": len(events), "events": events, "inner_box": inner}


def compute_border_events_merge(tracking_df: pd.DataFrame, seeker_id: str, bbox: Optional[Dict[str, float]]) -> Dict[str, Any]:
    """Previous border rule, kept for comparison only: every sample outside
    the inner box, merged into one event when less than 0.3 s apart."""
    if not bbox or tracking_df is None or tracking_df.empty:
        return {"count": 0, "events": [], "inner_box": None}
    p1 = _border_p1(tracking_df, seeker_id)
    if p1.empty:
        return {"count": 0, "events": [], "inner_box": None}
    inner = _border_inner_box(bbox)
    outside = (p1["x"] < inner["x_min"]) | (p1["x"] > inner["x_max"]) | (p1["y"] < inner["y_min"]) | (p1["y"] > inner["y_max"])
    items = [{"t_s": float(t)} for t in p1.loc[outside, "t_s"].dropna().to_numpy()]
    events = merge_events(items, time_key="t_s", gap_s=0.3)
    return {"count": len(events), "events": events, "inner_box": inner}


BORDER_COUNT_KEYS = (
    "border_reached_count", "task1_border_reached_count", "task2_border_reached_count",
    "border_reached_count_merge", "task1_border_reached_count_merge", "task2_border_reached_count_merge",
)


@_serialized
@lru_cache(maxsize=4096)
def load_border_counts(session_id: int, split_t_s: Optional[float]) -> Dict[str, Optional[int]]:
    """Border crossings of P1 in one recording, whole and per task (a crossing
    belongs to the task in which it STARTS), with the current rule and, under
    *_merge, the previous 0.3 s merge rule for comparison. Per-task values
    are None without a marked time."""
    row = get_sessions_df().iloc[int(session_id)]
    config = extract_config(load_json_cached(str(row["file_path"])))
    tracking_df = load_tracking_df(row["file_path"])
    bbox = compute_room_bbox(config["anchors"])
    out: Dict[str, Optional[int]] = {}
    for suffix, fn in (("", compute_border_events), ("_merge", compute_border_events_merge)):
        events = fn(tracking_df, config["seeker_id"], bbox)["events"]
        out[f"border_reached_count{suffix}"] = len(events)
        task1 = None if split_t_s is None else sum(1 for ev in events if ev["t_s"] <= split_t_s)
        out[f"task1_border_reached_count{suffix}"] = task1
        out[f"task2_border_reached_count{suffix}"] = None if task1 is None else len(events) - task1
    return out


def session_to_feedback_df(data: Dict[str, Any]) -> pd.DataFrame:
    rows = []
    raw_data = data.get("raw_data") or []
    for sample_idx, rec in enumerate(raw_data):
        activity_data = rec.get("activity_data") or {}
        event = activity_data.get("event")
        if not isinstance(event, dict) or event.get("type") != "feedback_changed":
            continue
        row = {
            "sample_idx": sample_idx,
            "timestamp": pd.to_datetime(rec.get("timestamp"), errors="coerce"),
            "state": activity_data.get("state"),
        }
        row.update(event)
        rows.append(row)
    df = pd.DataFrame(rows)
    if not df.empty:
        t0 = pd.to_datetime(raw_data[0].get("timestamp"), errors="coerce") if raw_data else df["timestamp"].min()
        df["t_s"] = (df["timestamp"] - t0).dt.total_seconds()
    return df


def compute_distances(tracking_df: pd.DataFrame, seeker_id: str = "P1", target_ids: Optional[List[str]] = None) -> pd.DataFrame:
    """Distance between the seeker and each landmark unit at every timestamp,
    on the horizontal plane (x, y) only — same choice as the route length.
    The vertical coordinate is left out: the seeker holds P1 in the hand, well
    above the units on the floor (about 0.75 m, and noisy), which made the
    3D distance some 0.4 m longer than the one the feedback itself works on.
    The horizontal distance matches the distance logged in the
    feedback_changed events."""
    if tracking_df.empty:
        return pd.DataFrame()
    if target_ids is None:
        target_ids = sorted([tid for tid in tracking_df["tag_id"].dropna().unique() if tid != seeker_id])
    p1 = tracking_df[tracking_df["tag_id"] == seeker_id][["timestamp", "t_s", "x", "y", "z"]].rename(
        columns={"x": "p1_x", "y": "p1_y", "z": "p1_z", "t_s": "p1_t_s"}
    )
    targets = tracking_df[tracking_df["tag_id"].isin(target_ids)][["timestamp", "t_s", "tag_id", "x", "y", "z"]].rename(columns={"tag_id": "target_id"})
    merged = targets.merge(p1, on="timestamp", how="inner")
    if merged.empty:
        return pd.DataFrame()
    merged["distance"] = np.hypot(merged["x"] - merged["p1_x"], merged["y"] - merged["p1_y"])
    return merged[["timestamp", "t_s", "target_id", "distance", "x", "y", "z", "p1_x", "p1_y", "p1_z"]].sort_values(["timestamp", "target_id"]).reset_index(drop=True)


def compute_closest_target_df(dist_df: pd.DataFrame) -> pd.DataFrame:
    if dist_df.empty:
        return pd.DataFrame()
    idx = dist_df.groupby("timestamp")["distance"].idxmin()
    closest = dist_df.loc[idx].sort_values("timestamp").reset_index(drop=True)
    return closest.rename(columns={"target_id": "closest_target_id", "distance": "closest_distance"})


def compute_speed_df(tracking_df: pd.DataFrame, seeker_id: str = "P1", rolling_window: int = 5) -> pd.DataFrame:
    if tracking_df.empty:
        return pd.DataFrame()
    p1 = tracking_df[tracking_df["tag_id"] == seeker_id].copy()
    if p1.empty:
        return pd.DataFrame()
    p1 = p1.sort_values("timestamp")
    p1["dt_s"] = p1["timestamp"].diff().dt.total_seconds()
    # Horizontal plane only: the hand-held unit's height changes are not walking.
    p1["dx"] = p1["x"].diff(); p1["dy"] = p1["y"].diff()
    p1["step_distance"] = np.hypot(p1["dx"], p1["dy"])
    p1["speed_m_s"] = p1["step_distance"] / p1["dt_s"]
    bad_speed = (p1["dt_s"] <= 0) | (~np.isfinite(p1["speed_m_s"]))
    p1.loc[bad_speed, "speed_m_s"] = np.nan
    p1["speed_m_s_smooth"] = p1["speed_m_s"].rolling(rolling_window, min_periods=1).median()
    return p1[["timestamp", "t_s", "x", "y", "z", "dt_s", "step_distance", "speed_m_s", "speed_m_s_smooth"]]


def split_time_for_file(file_name: Any, splits: Optional[Dict[str, Dict[str, Any]]] = None) -> Optional[float]:
    """The manually marked time (s from the start of the recording) that
    separates the two tasks of a recording — None when it has not been marked."""
    record = (splits if splits is not None else load_task_splits()).get(str(file_name))
    t_s = record.get("t_s") if isinstance(record, dict) else None
    return float(t_s) if t_s is not None else None


TASK_SEGMENT_KEYS = (
    "task1_length_m", "task1_duration_s", "task1_speed_m_s",
    "task2_length_m", "task2_duration_s", "task2_speed_m_s",
    "task1_movement_intensity_m_s2", "task2_movement_intensity_m_s2",
    "task1_stop_count", "task2_stop_count",
    "task1_stop_duration_s", "task2_stop_duration_s",
)


@_serialized
@lru_cache(maxsize=4096)
def load_task_segments(session_id: int, split_t_s: Optional[float]) -> Dict[str, Optional[float]]:
    """Length, duration and mean speed of the two tasks of one recording:
    task 1 from its start to the marked time (S, the three landmarks, E),
    task 2 from the marked time to its end (walk back from E to S).

    Same definitions as the whole-recording values: length = sum of the
    seeker's steps on the horizontal plane, speed = length / duration. A step
    belongs to task 1 when it ends at or before the marked time. All None when
    the recording has no marked time — never estimated.

    Also, per task:
    - movement intensity (m/s²): mean of the norm of the hand-held unit's
      linear acceleration (the seeker's accel_norm), leaving out the samples
      at zero (IMU not streaming) — same samples as max_accel_norm.
    - stops (compute_stop_events): how many, and their total duration. A stop
      is counted in the task where it STARTS, so the two counts add up to the
      whole recording; its duration is shared between the tasks by the time
      it actually spends in each, when it runs across the marked time.
    """
    empty: Dict[str, Optional[float]] = {k: None for k in TASK_SEGMENT_KEYS}
    if split_t_s is None:
        return empty
    row = get_sessions_df().iloc[int(session_id)]
    config = extract_config(load_json_cached(str(row["file_path"])))
    tracking_df = load_tracking_df(row["file_path"])
    speed_df = compute_speed_df(tracking_df, seeker_id=config["seeker_id"])
    if speed_df.empty:
        return empty
    t = pd.to_numeric(speed_df["t_s"], errors="coerce").to_numpy()
    step = pd.to_numeric(speed_df["step_distance"], errors="coerce").to_numpy()
    t_first, t_last = float(np.nanmin(t)), float(np.nanmax(t))
    split = min(max(float(split_t_s), t_first), t_last)
    in_task1 = t <= split
    out: Dict[str, Optional[float]] = dict(empty)
    for name, mask, duration in (("task1", in_task1, split - t_first), ("task2", ~in_task1, t_last - split)):
        length = float(np.nansum(step[mask]))
        out[f"{name}_length_m"] = length
        out[f"{name}_duration_s"] = float(duration)
        out[f"{name}_speed_m_s"] = float(length / duration) if duration > 0 else None

    if "accel_norm" in tracking_df.columns:
        seeker = tracking_df.loc[tracking_df["tag_id"] == config["seeker_id"], ["t_s", "accel_norm"]]
        accel = pd.to_numeric(seeker["accel_norm"], errors="coerce")
        accel_t = pd.to_numeric(seeker["t_s"], errors="coerce")
        streaming = accel > 0  # zeros = IMU not streaming
        for name, mask in (("task1", accel_t <= split), ("task2", accel_t > split)):
            values = accel[streaming & mask]
            out[f"{name}_movement_intensity_m_s2"] = float(values.mean()) if not values.empty else None

    # Same speed smoothing as the whole-recording stop count.
    stops = compute_stop_events(
        compute_speed_df(tracking_df, seeker_id=config["seeker_id"], rolling_window=settings.speed_rolling_window)
    )["events"]
    out["task1_stop_count"] = sum(1 for ev in stops if ev["t_s"] <= split)
    out["task2_stop_count"] = len(stops) - out["task1_stop_count"]
    out["task1_stop_duration_s"] = float(sum(max(0.0, min(ev["end_t_s"], split) - ev["t_s"]) for ev in stops))
    out["task2_stop_duration_s"] = float(sum(max(0.0, ev["end_t_s"] - max(ev["t_s"], split)) for ev in stops))
    return out


def add_ewma_plot_columns(
    tracking_df: pd.DataFrame,
    alpha: float = 0.2,
    tag_ids: Optional[List[str]] = None,
    source_cols: Tuple[str, str, str] = ("x", "y", "z"),
    suffix: str = "_plot",
) -> pd.DataFrame:
    if tracking_df.empty:
        return tracking_df.copy()
    df = tracking_df.copy()
    for col in source_cols:
        df[f"{col}{suffix}"] = df[col] if col in df.columns else np.nan
    try:
        alpha = float(alpha)
    except (TypeError, ValueError):
        alpha = settings.default_plot_alpha
    alpha = max(0.001, min(1.0, alpha))
    if alpha >= 0.999:
        return df
    tag_ids_to_smooth = set(df["tag_id"].dropna().unique().tolist()) if tag_ids is None else set(tag_ids)
    for tag_id, g in df.groupby("tag_id", dropna=False):
        if tag_id not in tag_ids_to_smooth:
            continue
        idx = g.sort_values("timestamp").index
        for col in source_cols:
            if col in df.columns:
                df.loc[idx, f"{col}{suffix}"] = df.loc[idx, col].astype(float).ewm(alpha=alpha, adjust=False).mean()
    return df


def summarize_session(data: Dict[str, Any], file_path: str) -> Dict[str, Any]:
    raw = data.get("raw_data") or []
    config = extract_config(data)
    status = session_status_from_raw(raw)
    return {
        "file": Path(file_path).name,
        "patient": data.get("patient"),
        "phase": data.get("task"),
        "condition": data.get("condition"),
        "condition_label": pretty_condition(data.get("condition")),
        "path_id": data.get("path_id"),
        "start_time": data.get("start_time"),
        "total_samples": data.get("total_samples", len(raw)),
        "n_raw": len(raw),
        "duration_s": _jsonable(status["duration_s"]),
        "last_state": status["last_state"],
        "status": status["status"],
        "warning": status["warning"],
        "seeker_id": config["seeker_id"],
        "target_ids": config["target_ids"],
        "delivery_target": config["condition_cfg"].get("delivery_target"),
        "selection_mode": config["feedback_task"].get("selection_mode"),
        "distance_cfg": config["distance_cfg"],
        "realtime_cooked_alpha": settings.realtime_cooked_alpha,
    }


def metric_summary(
    summary: Dict[str, Any],
    feedback_df: pd.DataFrame,
    closest_df: pd.DataFrame,
    speed_df: pd.DataFrame,
    tracking_df: Optional[pd.DataFrame] = None,
    seeker_id: Optional[str] = None,
) -> Dict[str, Any]:
    metrics: Dict[str, Any] = {
        "duration_s": summary.get("duration_s"),
        "samples": summary.get("n_raw"),
        "feedback_events": int(len(feedback_df)) if feedback_df is not None else 0,
        "mean_intensity": None,
        "max_intensity": None,
        "mean_feedback_distance": None,
        "min_feedback_distance": None,
        "mean_closest_distance": None,
        "min_closest_distance": None,
        "mean_speed_m_s": None,
        "max_speed_m_s": None,
        "total_distance_m": None,
        "max_accel_norm": None,
        "movement_intensity_m_s2": None,
        "feedback_events_per_min": None,
    }
    duration_s = summary.get("duration_s")
    if duration_s and duration_s > 0:
        metrics["feedback_events_per_min"] = metrics["feedback_events"] / (duration_s / 60.0)
    if feedback_df is not None and not feedback_df.empty:
        if "intensity" in feedback_df:
            metrics["mean_intensity"] = _jsonable(pd.to_numeric(feedback_df["intensity"], errors="coerce").mean())
            metrics["max_intensity"] = _jsonable(pd.to_numeric(feedback_df["intensity"], errors="coerce").max())
        if "distance" in feedback_df:
            metrics["mean_feedback_distance"] = _jsonable(pd.to_numeric(feedback_df["distance"], errors="coerce").mean())
            metrics["min_feedback_distance"] = _jsonable(pd.to_numeric(feedback_df["distance"], errors="coerce").min())
    if closest_df is not None and not closest_df.empty:
        metrics["mean_closest_distance"] = _jsonable(pd.to_numeric(closest_df["closest_distance"], errors="coerce").mean())
        metrics["min_closest_distance"] = _jsonable(pd.to_numeric(closest_df["closest_distance"], errors="coerce").min())
    if speed_df is not None and not speed_df.empty:
        metrics["max_speed_m_s"] = _jsonable(pd.to_numeric(speed_df["speed_m_s_smooth"], errors="coerce").max())
        total_distance_m = pd.to_numeric(speed_df["step_distance"], errors="coerce").sum()
        metrics["total_distance_m"] = _jsonable(total_distance_m)
        # Walking speed = trajectory length / recording duration (not the mean
        # of the per-sample speeds, which weights every sample equally).
        if duration_s and duration_s > 0:
            metrics["mean_speed_m_s"] = _jsonable(total_distance_m / duration_s)
    if tracking_df is not None and not tracking_df.empty and seeker_id is not None and "accel_norm" in tracking_df.columns:
        seeker_accel = pd.to_numeric(tracking_df.loc[tracking_df["tag_id"] == seeker_id, "accel_norm"], errors="coerce")
        seeker_accel = seeker_accel[seeker_accel > 0]  # zeros = IMU not streaming
        if not seeker_accel.empty:
            metrics["max_accel_norm"] = _jsonable(seeker_accel.max())
            # Movement intensity = mean of the same samples (m/s²).
            metrics["movement_intensity_m_s2"] = _jsonable(seeker_accel.mean())
    return metrics


@_serialized
@lru_cache(maxsize=2048)
def load_session_metrics(session_id: int) -> Dict[str, Any]:
    """Metrics only depend on the raw file, so cache them: comparisons across
    many patients would otherwise recompute every session on each request."""
    return _load_session_metrics_uncached(session_id)


def _load_session_metrics_uncached(session_id: int) -> Dict[str, Any]:
    sessions_df = get_sessions_df()
    if session_id < 0 or session_id >= len(sessions_df):
        raise IndexError(f"session_id non valido: {session_id}")
    row = sessions_df.iloc[int(session_id)]
    file_path = row["file_path"]
    data = load_json_cached(str(file_path))
    config = extract_config(data)
    summary = summarize_session(data, file_path)
    for key in ["patient", "phase", "condition", "condition_label", "path_id", "start_time"]:
        if summary.get(key) in (None, "unknown", "") and key in row.index:
            summary[key] = row[key]
    tracking_df = load_tracking_df(file_path)
    feedback_df = session_to_feedback_df(data)
    dist_df = compute_distances(tracking_df, seeker_id=config["seeker_id"], target_ids=config["target_ids"])
    closest_df = compute_closest_target_df(dist_df)
    speed_df = compute_speed_df(tracking_df, seeker_id=config["seeker_id"], rolling_window=settings.speed_rolling_window)
    return metric_summary(summary, feedback_df, closest_df, speed_df, tracking_df=tracking_df, seeker_id=config["seeker_id"])


def load_session_payload(
    session_id: int,
    alpha: float = 0.2,
    smooth_trajectory: bool = True,
    smooth_only_seeker: bool = True,
    max_points: Optional[int] = 2000,
) -> Dict[str, Any]:
    sessions_df = get_sessions_df()
    if session_id < 0 or session_id >= len(sessions_df):
        raise IndexError(f"session_id non valido: {session_id}")
    row = sessions_df.iloc[int(session_id)]
    file_path = row["file_path"]
    data = load_json_cached(str(file_path))
    config = extract_config(data)
    summary = summarize_session(data, file_path)
    for key in ["patient", "phase", "condition", "condition_label", "path_id", "start_time"]:
        if summary.get(key) in (None, "unknown", "") and key in row.index:
            summary[key] = row[key]

    tracking_df = load_tracking_df(file_path)
    feedback_df = session_to_feedback_df(data)
    orientation_df = session_to_orientation_df(data)
    dist_df = compute_distances(tracking_df, seeker_id=config["seeker_id"], target_ids=config["target_ids"])
    closest_df = compute_closest_target_df(dist_df)
    speed_df = compute_speed_df(tracking_df, seeker_id=config["seeker_id"], rolling_window=settings.speed_rolling_window)
    imu_quality = compute_imu_quality(tracking_df, config["seeker_id"], config["target_ids"])
    orientation = compute_orientation_consistency(tracking_df, orientation_df, config["seeker_id"])

    smooth_tag_ids = [config["seeker_id"]] if smooth_only_seeker else None
    tracking_plot_df = add_ewma_plot_columns(
        tracking_df,
        alpha=alpha if smooth_trajectory else 1.0,
        tag_ids=smooth_tag_ids,
    )
    if not orientation_df.empty:
        tracking_plot_df = tracking_plot_df.merge(
            orientation_df[["timestamp", "tag_id", "yaw_deg", "roll_deg", "pitch_deg", "qx", "qy", "qz", "qw"]],
            on=["timestamp", "tag_id"],
            how="left",
        )
    profile_df = config_to_profile_df(config)
    metrics = metric_summary(summary, feedback_df, closest_df, speed_df, tracking_df=tracking_df, seeker_id=config["seeker_id"])

    # Keep quantitative metrics on the full data, but send lighter arrays to React/Recharts.
    # This prevents the UI from freezing on long sessions or high-frequency recordings.
    tracking_plot_df_out = downsample_df(tracking_plot_df, max_points=max_points, group_col="tag_id")
    dist_df_out = downsample_df(dist_df, max_points=max_points, group_col="target_id")
    closest_df_out = downsample_df(closest_df, max_points=max_points)
    speed_df_out = downsample_df(speed_df, max_points=max_points)

    return {
        "summary": summary,
        "metrics": metrics,
        "config": {
            "seeker_id": config["seeker_id"],
            "target_ids": config["target_ids"],
            "distance_cfg": config["distance_cfg"],
            "anchors": config["anchors"],
            "condition_cfg": config["condition_cfg"],
        },
        "tracking": df_records(tracking_plot_df_out),
        "feedback": df_records(feedback_df),
        "distances": df_records(dist_df_out),
        "closest": df_records(closest_df_out),
        "speed": df_records(speed_df_out),
        "profiles": df_records(profile_df),
        "imu_quality": imu_quality,
        "orientation": orientation,
    }


def compare_sessions(
    patients: Optional[List[str]] = None,
    condition: Optional[str] = None,
    path_id: Optional[str] = None,
    phase: Optional[str] = None,
    include_suspicious: bool = True,
) -> List[Dict[str, Any]]:
    df = get_sessions_df().copy()
    if patients:
        df = df[df["patient"].isin(patients)]
    if condition and condition != "all":
        df = df[df["condition"] == condition]
    if path_id and path_id != "all":
        df = df[df["path_id"] == path_id]
    if phase and phase != "all":
        df = df[df["phase"] == phase]
    if not include_suspicious:
        df = df[~df["is_interrupt"] & ~df["is_suspicious_short"]]

    results: List[Dict[str, Any]] = []
    splits = load_task_splits()
    for _, r in df.iterrows():
        split_t_s = split_time_for_file(r["file_name"], splits)
        try:
            m = {**load_session_metrics(int(r["session_id"])), **load_task_segments(int(r["session_id"]), split_t_s)}
        except Exception as exc:
            m = {"error": str(exc)}
        results.append({
            "session_id": int(r["session_id"]),
            "patient": _jsonable(r["patient"]),
            "phase": _jsonable(r["phase"]),
            "condition": _jsonable(r["condition"]),
            "condition_label": _jsonable(r["condition_label"]),
            "path_id": _jsonable(r["path_id"]),
            "start_time": _jsonable(r["start_time"]),
            "warning": _jsonable(r["warning"]),
            "split_t_s": split_t_s,
            **{k: _jsonable(v) for k, v in m.items()},
        })
    return results


def build_trials_df() -> pd.DataFrame:
    """One row per (patient, condition, path_id, exploration attempt) — pairing every
    exploration session with the learning session it should be compared against.

    Reference learning session per trial: prefer the last non-interrupted one
    (chronologically); if none qualify, fall back to the last one anyway and flag it.
    Trials with zero exploration sessions still get one row (exploration_session_id=None)
    so they aren't silently dropped from the table.

    A trial with a manual pin (recording_pins.json) uses the pinned recording
    instead: the pinned learning one is the reference of every row of the
    trial, and the pinned exploration one is moved to the LAST row of the
    trial, since every consumer takes the last valid row as "the" attempt
    (it keeps its chronological attempt_number). A pin naming a file that is
    not a recording of that trial and phase is ignored.
    """
    sessions_df = get_sessions_df()
    if sessions_df.empty:
        return pd.DataFrame()

    pins = load_recording_pins()
    rows: List[Dict[str, Any]] = []
    for (patient, condition, path_id), g in sessions_df.groupby(["patient", "condition", "path_id"], dropna=False):
        pin = pins.get(pin_key(str(patient), str(condition), str(path_id)), {})
        condition_label = g["condition_label"].iloc[0] if "condition_label" in g else pretty_condition(condition)
        learning = g[g["phase"] == "learning"].sort_values("start_time_dt")
        exploration = g[g["phase"] == "exploration"].sort_values("start_time_dt")

        learning_session_id: Optional[int] = None
        learning_reference_flagged = False
        learning_is_interrupt = False
        if not learning.empty:
            non_interrupt = learning[~learning["is_interrupt"]]
            ref = non_interrupt.iloc[-1] if not non_interrupt.empty else learning.iloc[-1]
            learning_session_id = int(ref["session_id"])
            learning_is_interrupt = bool(ref["is_interrupt"])
            learning_reference_flagged = non_interrupt.empty
        learning_pinned = False
        pinned_learning = learning[learning["file_name"] == pin.get("learning")]
        if not pinned_learning.empty:
            ref = pinned_learning.iloc[-1]
            learning_session_id = int(ref["session_id"])
            learning_is_interrupt = bool(ref["is_interrupt"])
            learning_reference_flagged = False
            learning_pinned = True

        base = {
            "patient": patient, "condition": condition, "condition_label": condition_label, "path_id": path_id,
            "learning_session_id": learning_session_id,
            "learning_reference_flagged": learning_reference_flagged,
            "learning_pinned": learning_pinned,
            "exploration_pinned": False,
        }

        total_attempts = int(len(exploration))
        if total_attempts == 0:
            rows.append({
                **base,
                "exploration_session_id": None,
                "attempt_number": None, "total_attempts": 0,
                "attempt_lost": False,
                "trial_got_lost": learning_is_interrupt,
            })
            continue

        pinned_file = pin.get("exploration") if (exploration["file_name"] == pin.get("exploration")).any() else None
        trial_rows: List[Dict[str, Any]] = []
        for attempt_number, (_, exp_row) in enumerate(exploration.iterrows(), start=1):
            is_pinned = pinned_file is not None and exp_row["file_name"] == pinned_file
            # The attempt in use is the pinned one, else the latest; any other is superseded.
            superseded = (not is_pinned) if pinned_file is not None else attempt_number < total_attempts
            attempt_lost = bool(exp_row["is_interrupt"]) or bool(exp_row["is_suspicious_short"]) or superseded
            trial_rows.append({
                **base,
                "exploration_session_id": int(exp_row["session_id"]),
                "attempt_number": attempt_number, "total_attempts": total_attempts,
                "attempt_lost": attempt_lost,
                "trial_got_lost": attempt_lost or learning_is_interrupt,
                "exploration_pinned": is_pinned,
            })
        trial_rows.sort(key=lambda row: row["exploration_pinned"])  # stable: pinned row last
        rows.extend(trial_rows)
    return pd.DataFrame(rows)


def learning_target_order(learn_feedback_df: pd.DataFrame, target_ids_in_order: List[str]) -> List[str]:
    """The order targets actually first triggered feedback during the LEARNING
    session — this is the real "correct" order for a trial, not the raw
    hider_sequence_id config field. Empirically the two frequently disagree
    (checked across real sessions: only ~1 in 12 matched exactly), since
    hider_sequence_id looks like a static per-path label rather than a live
    walkthrough script. Any target learning itself never triggered falls back
    to its hider_sequence_id position, appended after the ones that did."""
    discovered: List[Tuple[str, float]] = []
    for tid in target_ids_in_order:
        rows = learn_feedback_df[learn_feedback_df["target_id"] == tid] if learn_feedback_df is not None and not learn_feedback_df.empty else None
        if rows is not None and not rows.empty and "t_s" in rows:
            discovered.append((tid, float(rows["t_s"].min())))
    discovered.sort(key=lambda x: x[1])
    order = [d[0] for d in discovered]
    for tid in target_ids_in_order:
        if tid not in order:
            order.append(tid)
    return order


def compute_target_discovery(feedback_df: pd.DataFrame, target_ids_in_order: List[str]) -> Dict[str, Any]:
    """Which of the trial's targets got any feedback during exploration ("found"
    = made it sound/vibrate at all, not just reaching the closest zone), in what
    order, and whether that order matches the learning session's own actual
    visit order (target_ids_in_order should be learning_target_order(...), not
    the raw hider_sequence_id — see that function's docstring for why).

    Feedback-only — deliberately doesn't know about manually-entered target
    coordinates (see apply_manual_target_coords below): this result is cached
    via load_trial_metrics, and a coordinate the researcher enters later must
    take effect immediately, not only after the cache is invalidated.
    """
    targets_out: List[Dict[str, Any]] = []
    discovered: List[Tuple[str, float]] = []
    empty_df = feedback_df.iloc[0:0] if feedback_df is not None else pd.DataFrame()
    for idx, tid in enumerate(target_ids_in_order):
        rows = feedback_df[feedback_df["target_id"] == tid] if feedback_df is not None and not feedback_df.empty else empty_df
        found = not rows.empty
        first_t = float(rows["t_s"].min()) if found and "t_s" in rows else None
        min_bucket = int(rows["bucket"].min()) if found and "bucket" in rows and rows["bucket"].notna().any() else None
        max_intensity = float(rows["intensity"].max()) if found and "intensity" in rows and rows["intensity"].notna().any() else None
        targets_out.append({
            "target_id": tid, "path_order": idx, "found": found,
            "first_feedback_t_s": first_t, "min_bucket": min_bucket, "max_intensity": max_intensity,
            "source": "feedback" if found else None, "manual_xy": None,
        })
        if found and first_t is not None:
            discovered.append((tid, first_t))
    discovered.sort(key=lambda x: x[1])
    discovery_order = [d[0] for d in discovered]
    # Relative order check so partial finds (e.g. only 2 of 3) are still well-defined:
    # compare against the intended order restricted to only the targets actually found.
    expected_relative_order = [t for t in target_ids_in_order if t in discovery_order]
    return {
        "targets": targets_out,
        "found_count": len(discovery_order),
        "discovery_order": discovery_order,
        "in_order": (discovery_order == expected_relative_order) if discovery_order else None,
    }


def apply_manual_target_coords(
    target_discovery: Dict[str, Any],
    exp_xy: pd.DataFrame,
    manual_coords: Dict[str, List[float]],
) -> Dict[str, Any]:
    """Re-derive found/source/order for a (cached, feedback-only) target_discovery
    dict using freshly-loaded manual coordinates — called from compare_trials,
    outside any cache, so a newly-entered coordinate is reflected immediately.

    Some conditions (e.g. haptic_on_object_intes) never tracked the O1/O2/O3
    tags at all — only the seeker P1 — so feedback events may be sparse or
    absent even though the participant genuinely walked up to the object. When
    a target isn't found via feedback and the researcher has manually entered
    that target's real-world coordinate (the sensor position doesn't exist to
    derive it from), fall back to a distance check: the seeker's own
    trajectory (exp_xy) coming within settings.manual_target_found_radius_m of
    that point also counts as found.
    """
    if not manual_coords:
        return target_discovery
    target_ids_in_order = [t["target_id"] for t in sorted(target_discovery["targets"], key=lambda t: t["path_order"])]
    targets_out: List[Dict[str, Any]] = []
    discovered: List[Tuple[str, float]] = []
    has_xy = exp_xy is not None and not exp_xy.empty
    ex = exp_xy["x"].to_numpy() if has_xy else None
    ey = exp_xy["y"].to_numpy() if has_xy else None
    et = exp_xy["t_s"].to_numpy() if has_xy else None
    for t in target_discovery["targets"]:
        t = dict(t)
        tid = t["target_id"]
        manual_xy = [float(v) for v in manual_coords[tid]] if tid in manual_coords else None
        if not t["found"] and manual_xy is not None and has_xy:
            dists = np.hypot(ex - manual_xy[0], ey - manual_xy[1])
            within = np.where(dists <= settings.manual_target_found_radius_m)[0]
            if len(within):
                t["found"] = True
                t["source"] = "manual_distance"
                t["first_feedback_t_s"] = float(et[within[0]])
        t["manual_xy"] = manual_xy
        targets_out.append(t)
        if t["found"] and t["first_feedback_t_s"] is not None:
            discovered.append((tid, t["first_feedback_t_s"]))
    discovered.sort(key=lambda x: x[1])
    discovery_order = [d[0] for d in discovered]
    expected_relative_order = [t for t in target_ids_in_order if t in discovery_order]
    return {
        "targets": targets_out,
        "found_count": len(discovery_order),
        "discovery_order": discovery_order,
        "in_order": (discovery_order == expected_relative_order) if discovery_order else None,
    }


def apply_manual_discovery_overrides(
    target_discovery: Dict[str, Any],
    override: Dict[str, Any],
) -> Dict[str, Any]:
    """Manual found/in-order flags (manual_discovery.py) always win over the
    automatic feedback/distance-based detection above (apply_manual_target_coords)
    — for cases where the researcher directly knows the outcome (e.g. from
    notes/video) better than the heuristics can guess it. Uncached, like
    apply_manual_target_coords, so a flag entered a moment ago is reflected
    immediately, without needing /api/refresh. Always run (even with no
    override set) so manual_found_override/manual_in_order_override are
    always present in the response — the frontend's tri-state selects
    (Auto-detected / Found / Not found) need the raw override value, not
    just its effect on `found`, to know which option is selected.

    A manual "found" override only flips the found/not-found fact. Since a
    manually-flagged find has no real timestamp, it drops out of
    discovery_order (it can't be timing-ordered against the others) — it
    still counts toward found_count, but the automatic in_order verdict
    becomes unreliable once that happens, which is exactly when the manual
    "in_order" override (replacing the verdict outright) is meant to be used.
    """
    targets_found_override: Dict[str, bool] = override.get("targets_found") or {}
    in_order_override: Optional[bool] = override.get("in_order")
    targets_out: List[Dict[str, Any]] = []
    discovery_order = list(target_discovery["discovery_order"])
    for t in target_discovery["targets"]:
        t = dict(t)
        tid = t["target_id"]
        manual_found = targets_found_override.get(tid)
        t["manual_found_override"] = manual_found
        if manual_found is not None and manual_found != t["found"]:
            t["found"] = manual_found
            t["source"] = "manual_flag" if manual_found else None
            if not manual_found:
                t["first_feedback_t_s"] = None
            discovery_order = [d for d in discovery_order if d != tid]
        targets_out.append(t)
    found_count = sum(1 for t in targets_out if t["found"])
    in_order = in_order_override if in_order_override is not None else target_discovery["in_order"]
    return {
        "targets": targets_out,
        "found_count": found_count,
        "discovery_order": discovery_order,
        "in_order": in_order,
        "manual_in_order_override": in_order_override,
    }


def compute_target_impacts(tracking_df: pd.DataFrame, seeker_id: str, target_ids: List[str]) -> Dict[str, int]:
    """Number of probable physical hits per target tag (reuses the impact
    detection already used for IMU quality — a target sensor spiking above its
    stationary baseline means the participant knocked into it)."""
    imu = compute_imu_quality(tracking_df, seeker_id, target_ids)
    counts: Dict[str, int] = {}
    for ev in imu.get("events", []):
        if ev.get("tag_id") in target_ids:
            counts[ev["tag_id"]] = counts.get(ev["tag_id"], 0) + 1
    return counts


def resample_by_arclength(xy: np.ndarray, n_points: int) -> np.ndarray:
    """Resample an (N, 2) polyline to n_points equally spaced by arc length
    (distance traveled), not by sample index/time — so two trajectories walked
    at different speeds still compare point-by-point at the same relative
    position along their own route, not at the same moment in time."""
    if len(xy) == 1:
        return np.repeat(xy, n_points, axis=0)
    deltas = np.diff(xy, axis=0)
    seg_lengths = np.hypot(deltas[:, 0], deltas[:, 1])
    cum_lengths = np.concatenate([[0.0], np.cumsum(seg_lengths)])
    total_length = cum_lengths[-1]
    if total_length == 0:
        return np.repeat(xy[:1], n_points, axis=0)
    target_lengths = np.linspace(0.0, total_length, n_points)
    x_resampled = np.interp(target_lengths, cum_lengths, xy[:, 0])
    y_resampled = np.interp(target_lengths, cum_lengths, xy[:, 1])
    return np.column_stack([x_resampled, y_resampled])


def discrete_frechet_distance(p: np.ndarray, q: np.ndarray) -> float:
    """Discrete Fréchet distance (Eiter & Mannila, 1994) between two point
    sequences p (n points) and q (m points): the smallest "leash length"
    connecting a walker on p to a walker on q if both may only move forward
    (never backtrack) along their own sequence, choosing their pace
    independently to minimize the longest leash needed at any moment.

    Recurrence (d = Euclidean distance between two points):
        ca(0,0)   = d(p_0, q_0)
        ca(i,0)   = max(ca(i-1,0), d(p_i, q_0))
        ca(0,j)   = max(ca(0,j-1), d(p_0, q_j))
        ca(i,j)   = max(d(p_i, q_j), min(ca(i-1,j), ca(i-1,j-1), ca(i,j-1)))
    Result = ca(n-1, m-1).

    Unlike a mean deviation, this is a worst-case number: a single detour
    raises it for the whole trial even if every other point matches closely.
    Run on the same 100-point arc-length-resampled routes as shape_overlap_pct
    (see resample_by_arclength) — O(n*m) DP, cheap at that size, and directly
    comparable between the two metrics.
    """
    n, m = len(p), len(q)
    # Plain Python lists, not numpy scalar indexing, inside the DP loop: with
    # bulk fetches computing this for every trial (100x100 = 10k cells each),
    # numpy's per-element access overhead made this the single slowest part
    # of the whole bulk endpoint — plain float/list ops are ~10x faster here.
    d = np.hypot(p[:, None, 0] - q[None, :, 0], p[:, None, 1] - q[None, :, 1]).tolist()
    ca = [[0.0] * m for _ in range(n)]
    ca[0][0] = d[0][0]
    for i in range(1, n):
        ca[i][0] = max(ca[i - 1][0], d[i][0])
    for j in range(1, m):
        ca[0][j] = max(ca[0][j - 1], d[0][j])
    for i in range(1, n):
        ca_i, ca_im1, d_i = ca[i], ca[i - 1], d[i]
        for j in range(1, m):
            ca_i[j] = max(min(ca_im1[j], ca_im1[j - 1], ca_i[j - 1]), d_i[j])
    return float(ca[-1][-1])


def dtw_distance(p: np.ndarray, q: np.ndarray) -> float:
    """Dynamic Time Warping distance between p (n points) and q (m points),
    normalized by n so the result is an average cost per step, in meters —
    directly comparable to shape_deviation_m. Unlike Fréchet's rigid
    "move forward one step at a time" pairing, DTW may match one point on p
    against several consecutive points on q (and vice versa), so it tolerates
    pacing differences — e.g. pausing, or a slightly longer detour that still
    ends up in the same place — that a same-index or step-locked comparison
    would over-penalize. Unlike Fréchet's worst case, this is a total/average,
    so it's dragged down by every point rather than dominated by the single
    worst one.

    Recurrence (d = Euclidean distance between two points):
        dtw(0,0) = 0
        dtw(i,j) = d(p_i, q_j) + min(dtw(i-1,j), dtw(i-1,j-1), dtw(i,j-1))
    Result = dtw(n,m) / n.
    """
    return dtw_alignment(p, q)[0]


# Distances (m) within which a DTW-matched pair of points counts as corresponding.
DTW_MATCH_RADII_M = (0.5, 1.0)


def dtw_alignment(p: np.ndarray, q: np.ndarray) -> Tuple[float, np.ndarray]:
    """dtw_distance (cost / n) and the distance of every matched pair along
    the optimal DTW path (traced back from (n, m) to (1, 1); on ties the
    diagonal step is preferred)."""
    n, m = len(p), len(q)
    d = np.hypot(p[:, None, 0] - q[None, :, 0], p[:, None, 1] - q[None, :, 1]).tolist()
    inf = float("inf")
    dtw = [[inf] * (m + 1) for _ in range(n + 1)]
    dtw[0][0] = 0.0
    for i in range(1, n + 1):
        dtw_i, dtw_im1, d_im1 = dtw[i], dtw[i - 1], d[i - 1]
        for j in range(1, m + 1):
            dtw_i[j] = d_im1[j - 1] + min(dtw_im1[j], dtw_im1[j - 1], dtw_i[j - 1])
    pair_distances = []
    i, j = n, m
    while i > 0 and j > 0:
        pair_distances.append(d[i - 1][j - 1])
        diag, up, left = dtw[i - 1][j - 1], dtw[i - 1][j], dtw[i][j - 1]
        if diag <= up and diag <= left:
            i, j = i - 1, j - 1
        elif up <= left:
            i -= 1
        else:
            j -= 1
    return float(dtw[n][m] / n), np.array(pair_distances[::-1])


def dtw_match_pcts(pair_distances: np.ndarray) -> Dict[str, Optional[float]]:
    """Correspondence index: share (%) of the DTW-matched pairs of points that
    are within each of DTW_MATCH_RADII_M of each other."""
    out: Dict[str, Optional[float]] = {}
    for r in DTW_MATCH_RADII_M:
        key = f"{r:g}".replace(".", "")
        out[key] = float(100.0 * np.mean(pair_distances <= r)) if pair_distances.size else None
    return out


def lcss_similarity_pct(p: np.ndarray, q: np.ndarray, epsilon: float) -> float:
    """Longest Common Subsequence similarity (%) between p (n points) and q
    (m points): the longest run of point-pairs (i, j), taken in order but with
    any number of unmatched points freely skipped on either side, where each
    matched pair is within epsilon of each other — normalized by the shorter
    route's length so a full match = 100%. Unlike Fréchet/DTW/shape overlap,
    which score EVERY point (one bad detour drags all three down), LCSS simply
    skips a detour or noisy stretch entirely instead of being penalized by it
    — the most forgiving of the group, and the best at answering "did most of
    the route still match, ignoring one bad patch?".

    Recurrence (d = Euclidean distance between two points):
        lcss(i,j) = lcss(i-1,j-1) + 1               if d(p_i, q_j) <= epsilon
        lcss(i,j) = max(lcss(i-1,j), lcss(i,j-1))    otherwise
    Result = 100 * lcss(n,m) / min(n,m).
    """
    n, m = len(p), len(q)
    if min(n, m) == 0:
        return 0.0
    d = np.hypot(p[:, None, 0] - q[None, :, 0], p[:, None, 1] - q[None, :, 1]).tolist()
    lcss = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        lcss_i, lcss_im1, d_im1 = lcss[i], lcss[i - 1], d[i - 1]
        for j in range(1, m + 1):
            if d_im1[j - 1] <= epsilon:
                lcss_i[j] = lcss_im1[j - 1] + 1
            else:
                lcss_i[j] = max(lcss_im1[j], lcss_i[j - 1])
    return float(100.0 * lcss[n][m] / min(n, m))


def compute_trial_metrics(
    learning_session_id: Optional[int],
    exploration_session_id: Optional[int],
    learning_split_t_s: Optional[float] = None,
    exploration_split_t_s: Optional[float] = None,
) -> Dict[str, Any]:
    """Compare an exploration trajectory against its trial's learning trajectory:
    route overlap, turn-by-turn deviation, and stop/start position drift.

    The route comparison (overlap, shape, Fréchet, DTW, LCSS) and the distance
    from the end point use only task 1 of each recording — its samples up to
    the manually marked time — cut BEFORE resampling. They stay None unless
    both recordings have a marked time: nothing is estimated."""
    empty = {
        "overlap_pct": None, "mean_deviation_m": None,
        "shape_overlap_pct": None, "shape_deviation_m": None, "frechet_distance_m": None,
        "dtw_distance_m": None, "dtw_task2_distance_m": None,
        "dtw_match_05m_pct": None, "dtw_match_1m_pct": None, "dtw_task2_match_05m_pct": None, "dtw_task2_match_1m_pct": None, "lcss_pct": None, "shape_deviation_profile": None,
        "learn_resampled_xy": None, "exp_resampled_xy": None,
        "turns": [], "wrong_turns_count": None, "mean_turn_deviation_deg": None,
        "stop_position_distance_m": None, "start_position_distance_m": None,
        "ideal_stop_xy": None, "ideal_start_xy": None,
        "return_to_start_distance_m": None, "self_return_distance_m": None,
        "target_discovery": None, "target_impacts": {},
        "ideal_path_length_m": None,
        "learning_split_xy": None, "exploration_split_xy": None, "exploration_end_xy": None, "exploration_start_xy": None,
    }
    if learning_session_id is None or exploration_session_id is None:
        return {**empty, "note": "missing learning or exploration session for this trial"}

    sessions_df = get_sessions_df()
    learn_row = sessions_df.iloc[int(learning_session_id)]
    exp_row = sessions_df.iloc[int(exploration_session_id)]
    learn_data = load_json_cached(str(learn_row["file_path"]))
    exp_data = load_json_cached(str(exp_row["file_path"]))
    learn_config = extract_config(learn_data)
    exp_config = extract_config(exp_data)

    exp_tracking_df = load_tracking_df(exp_row["file_path"])
    learn_tracking_df = load_tracking_df(learn_row["file_path"])
    learn_xy = p1_xy(learn_tracking_df, learn_config["seeker_id"])
    exp_xy = p1_xy(exp_tracking_df, exp_config["seeker_id"])
    if learn_xy.empty or exp_xy.empty:
        return {**empty, "note": "empty trajectory for learning or exploration session"}

    # "Correct" visit order = the order targets actually first sounded during
    # the learning session itself (not the raw hider_sequence_id config field
    # — see learning_target_order's docstring for why that's the wrong source).
    intended_order = learning_target_order(session_to_feedback_df(learn_data), learn_config["target_ids"])
    # Landmarks belong to task 1: only the signals up to the marked point E
    # count (participants pass near them again while walking back). Whole
    # recording when E is not marked.
    exp_feedback_df = session_to_feedback_df(exp_data)
    if exploration_split_t_s is not None and not exp_feedback_df.empty and "t_s" in exp_feedback_df:
        exp_feedback_df = exp_feedback_df[exp_feedback_df["t_s"] <= exploration_split_t_s]
    target_discovery = compute_target_discovery(exp_feedback_df, intended_order)
    target_impacts = compute_target_impacts(exp_tracking_df, exp_config["seeker_id"], exp_config["target_ids"])

    lx, ly = learn_xy["x"].to_numpy(), learn_xy["y"].to_numpy()
    ex, ey = exp_xy["x"].to_numpy(), exp_xy["y"].to_numpy()

    # Task 1 of each recording: its samples up to the manually marked time.
    def _task1(xy: pd.DataFrame, split_t_s: Optional[float]) -> Optional[np.ndarray]:
        if split_t_s is None:
            return None
        part = xy[xy["t_s"] <= split_t_s]
        return part[["x", "y"]].to_numpy() if not part.empty else None

    learn_task1 = _task1(learn_xy, learning_split_t_s)
    exp_task1 = _task1(exp_xy, exploration_split_t_s)
    learning_split_xy = [float(learn_task1[-1, 0]), float(learn_task1[-1, 1])] if learn_task1 is not None else None
    exploration_split_xy = [float(exp_task1[-1, 0]), float(exp_task1[-1, 1])] if exp_task1 is not None else None

    # Task 2 of each recording (walk back): its samples from the marked time on.
    def _task2(xy: pd.DataFrame, split_t_s: Optional[float]) -> Optional[np.ndarray]:
        if split_t_s is None:
            return None
        part = xy[xy["t_s"] >= split_t_s]
        return part[["x", "y"]].to_numpy() if len(part) >= 2 else None

    learn_task2 = _task2(learn_xy, learning_split_t_s)
    exp_task2 = _task2(exp_xy, exploration_split_t_s)
    dtw_task2_distance_m = None
    dtw_task2_match: Dict[str, Optional[float]] = {}
    if learn_task2 is not None and exp_task2 is not None:
        n_task2 = settings.trial_shape_resample_points
        dtw_task2_distance_m, task2_pairs = dtw_alignment(resample_by_arclength(learn_task2, n_task2), resample_by_arclength(exp_task2, n_task2))
        dtw_task2_match = dtw_match_pcts(task2_pairs)

    overlap_pct = mean_deviation_m = None
    shape_overlap_pct = shape_deviation_m = frechet_distance_m = dtw_distance_m = lcss_pct = None
    shape_deviation_profile = learn_resampled_xy = exp_resampled_xy = None
    dtw_task1_match: Dict[str, Optional[float]] = {}
    stop_position_distance_m = None
    if learn_task1 is not None and exp_task1 is not None:
        l1x, l1y = learn_task1[:, 0], learn_task1[:, 1]
        e1x, e1y = exp_task1[:, 0], exp_task1[:, 1]
        # Overlap: fraction of exploration points that fall within the buffer distance
        # of the learning trajectory (nearest-neighbor distance, point-wise). Vectorized
        # pairwise distance matrix instead of a Python-level loop: with sessions running
        # into thousands of samples, a per-point loop held the GIL long enough to stall
        # other concurrent requests (e.g. a rapid sequence of dropdown changes).
        min_dist = np.hypot(e1x[:, None] - l1x[None, :], e1y[:, None] - l1y[None, :]).min(axis=1)
        overlap_pct = float(100.0 * np.mean(min_dist <= settings.trial_overlap_buffer_m))
        mean_deviation_m = float(min_dist.mean())

        # Shape overlap: same buffer threshold as above, but point-by-point at the
        # same relative position along each route (arc-length resampled) instead
        # of nearest-neighbor-anywhere-on-the-route — this respects order/direction,
        # so wandering back and forth in the same general area (which can score
        # high on overlap_pct) doesn't score high here unless it's the same shape.
        n_pts = settings.trial_shape_resample_points
        learn_resampled = resample_by_arclength(learn_task1, n_pts)
        exp_resampled = resample_by_arclength(exp_task1, n_pts)
        pointwise_dist = np.hypot(
            exp_resampled[:, 0] - learn_resampled[:, 0], exp_resampled[:, 1] - learn_resampled[:, 1]
        )
        shape_overlap_pct = float(100.0 * np.mean(pointwise_dist <= settings.trial_overlap_buffer_m))
        shape_deviation_m = float(pointwise_dist.mean())
        frechet_distance_m = discrete_frechet_distance(learn_resampled, exp_resampled)
        dtw_distance_m, task1_pairs = dtw_alignment(learn_resampled, exp_resampled)
        dtw_task1_match = dtw_match_pcts(task1_pairs)
        lcss_pct = lcss_similarity_pct(learn_resampled, exp_resampled, settings.trial_overlap_buffer_m)
        shape_deviation_profile = pointwise_dist.tolist()
        learn_resampled_xy = learn_resampled.tolist()
        exp_resampled_xy = exp_resampled.tolist()
        # Distance from the end point: the two marked points E, never the
        # recordings' last samples (those are the end of the walk back).
        stop_position_distance_m = float(math.hypot(learn_task1[-1, 0] - exp_task1[-1, 0], learn_task1[-1, 1] - exp_task1[-1, 1]))

    # Reference turn angle at each target = the geometric angle of the IDEAL
    # straight-line route start -> O_n -> O_n+1 -> O_n+2 -> stop (the path's
    # own design intent), not whatever the noisy recorded learning trajectory
    # happened to measure there (see canonical_turn_angles' docstring — a
    # pause or confused circling right at a target could make that specific
    # measurement read anywhere from ~0° to 300°+, contaminating the very
    # thing it's supposed to be the trustworthy reference for). No waypoint
    # for a target this condition never tracked (e.g. haptic_on_object_intes)
    # — that target is simply skipped, not guessed at.
    target_positions = target_tag_positions(learn_tracking_df, learn_config["target_ids"])
    ordered_target_positions = [(tid, target_positions[tid]) for tid in intended_order if tid in target_positions]
    waypoints = [("start", (float(lx[0]), float(ly[0]))), *ordered_target_positions, ("stop", (float(lx[-1]), float(ly[-1])))]
    # Shortest possible route through the waypoints in visit order — straight
    # line start -> O_n -> O_n+1 -> ... -> stop, NOT the learning trajectory's
    # own (noisy, longer) path. This is the "ideal" length behind the
    # path-efficiency metric in compute_navigation_metrics: ideal / actual
    # distance traveled — see that function's docstring for where this exact
    # ratio is actually precedented (Morris water maze spatial-navigation
    # research).
    ideal_path_length_m = sum(
        math.hypot(waypoints[i + 1][1][0] - waypoints[i][1][0], waypoints[i + 1][1][1] - waypoints[i][1][1])
        for i in range(len(waypoints) - 1)
    )
    turns = canonical_turn_angles(waypoints)
    turn_results = []
    deviations = []
    for t in turns:
        exp_change = heading_change_near_point(exp_xy, (t["x"], t["y"]), settings.turn_miss_radius_m)
        deviation_deg = None
        wrong_turn = True
        if exp_change is not None:
            deviation_deg = float(abs((exp_change - t["heading_change_deg"] + 180.0) % 360.0 - 180.0))
            wrong_turn = deviation_deg > settings.wrong_turn_threshold_deg
        turn_results.append({
            "turn_index": t["turn_index"],
            "target_id": t["target_id"],
            "x": t["x"],
            "y": t["y"],
            "ideal_heading_change_deg": t["heading_change_deg"],
            "exploration_heading_change_deg": exp_change,
            "deviation_deg": deviation_deg,
            "wrong_turn": wrong_turn,
        })
        if deviation_deg is not None:
            deviations.append(deviation_deg)

    return {
        "overlap_pct": overlap_pct,
        "mean_deviation_m": mean_deviation_m,
        "shape_overlap_pct": shape_overlap_pct,
        "shape_deviation_m": shape_deviation_m,
        "frechet_distance_m": frechet_distance_m,
        "dtw_distance_m": dtw_distance_m,
        # Correspondence index: % of DTW-matched point pairs within 0.5 / 1.0 m.
        "dtw_match_05m_pct": dtw_task1_match.get("05"),
        "dtw_match_1m_pct": dtw_task1_match.get("1"),
        "dtw_task2_match_05m_pct": dtw_task2_match.get("05"),
        "dtw_task2_match_1m_pct": dtw_task2_match.get("1"),
        "lcss_pct": lcss_pct,
        "dtw_task2_distance_m": dtw_task2_distance_m,
        # Per-point deviation (d_k from the Shape overlap definition), exposed
        # so the frontend can chart "how far apart were learning and exploration
        # at k% of the way along the route" instead of only the mean/threshold
        # summary above — shows WHERE along the route the deviation happened.
        "shape_deviation_profile": shape_deviation_profile,
        # The actual (x, y) of the two 100-point resampled routes — lets the
        # frontend highlight "point k" on the map when hovering point k on the
        # deviation profile chart, without re-implementing the resampling.
        "learn_resampled_xy": learn_resampled_xy,
        "exp_resampled_xy": exp_resampled_xy,
        "turns": turn_results,
        # None (not 0) when no target position could be anchored at all (e.g.
        # haptic_on_object_intes never tracked O1/O2/O3) — 0 would misleadingly
        # read as "checked, no wrong turns" rather than "couldn't check".
        "wrong_turns_count": sum(1 for t in turn_results if t["wrong_turn"]) if turn_results else None,
        "mean_turn_deviation_deg": float(np.mean(deviations)) if deviations else None,
        # Distance from the end point: marked point E of the exploration vs
        # marked point E of the learning recording (None until both are marked).
        "stop_position_distance_m": stop_position_distance_m,
        # Start position: how far the exploration's start point is from the
        # learning trajectory's own start point (the "ideal" start location).
        "start_position_distance_m": float(math.hypot(lx[0] - ex[0], ly[0] - ey[0])),
        "ideal_stop_xy": learning_split_xy,
        "learning_split_xy": learning_split_xy,
        "exploration_split_xy": exploration_split_xy,
        "exploration_end_xy": [float(ex[-1]), float(ey[-1])],
        "exploration_start_xy": [float(ex[0]), float(ey[0])],
        "ideal_start_xy": [float(lx[0]), float(ly[0])],
        # Return distance: the exploration's LAST position vs the learning
        # recording's FIRST position — did they go out and come back?
        # (Reuses ideal_start_xy as the same "ideal" point for this metric too.)
        "return_to_start_distance_m": float(math.hypot(lx[0] - ex[-1], ly[0] - ey[-1])),
        # Self-referential variant: exploration's own END point vs its own START
        # point (ignores the learning session's start entirely) — investigative
        # field to check whether anchoring "completed" to the exploration's own
        # start (rather than learning's) changes how many trials count as completed.
        "self_return_distance_m": float(math.hypot(ex[0] - ex[-1], ey[0] - ey[-1])),
        "target_discovery": target_discovery,
        "target_impacts": target_impacts,
        "ideal_path_length_m": float(ideal_path_length_m),
    }


@_serialized
@lru_cache(maxsize=2048)
def load_trial_metrics(
    learning_session_id: Optional[int],
    exploration_session_id: Optional[int],
    learning_split_t_s: Optional[float] = None,
    exploration_split_t_s: Optional[float] = None,
) -> Dict[str, Any]:
    # The marked times are part of the cache key, so marking or clearing a
    # point E recomputes exactly the trials it touches.
    return compute_trial_metrics(learning_session_id, exploration_session_id, learning_split_t_s, exploration_split_t_s)


def trial_split_times(learning_session_id: Optional[int], exploration_session_id: Optional[int]) -> Tuple[Optional[float], Optional[float]]:
    sessions_df = get_sessions_df()
    splits = load_task_splits()
    return tuple(  # type: ignore[return-value]
        split_time_for_file(sessions_df.iloc[int(sid)]["file_name"], splits) if sid is not None else None
        for sid in (learning_session_id, exploration_session_id)
    )


@_serialized
@lru_cache(maxsize=2048)
def load_exploration_movement_events(exploration_session_id: int) -> Dict[str, Any]:
    """Stop and border-crossing counts for one exploration session, cached —
    compare_trials (every trial, every patient) and compute_speed_accel_correlations
    (every trial in the whole dataset) both need this same tracking-file reload,
    and it doesn't depend on anything that a manual annotation/coordinate edit
    would change (unlike load_trial_metrics' target discovery)."""
    sessions_df = get_sessions_df()
    row = sessions_df.iloc[int(exploration_session_id)]
    data = load_json_cached(str(row["file_path"]))
    config = extract_config(data)
    tracking_df = load_tracking_df(row["file_path"])
    speed_df = compute_speed_df(tracking_df, seeker_id=config["seeker_id"], rolling_window=settings.speed_rolling_window)
    bbox = compute_room_bbox(config["anchors"])
    return {
        "stop_count": compute_stop_events(speed_df)["count"],
        "border_reached_count": compute_border_events(tracking_df, config["seeker_id"], bbox)["count"],
    }


TASK_EVENT_KEYS = (
    "task1_min_closest_distance_m",
    "task1_target_feedback_depth_pct", "task1_approach_depth_pct",
    "task1_stop_count", "task1_border_reached_count", "task1_impact_count",
    "task2_stop_count", "task2_border_reached_count", "task2_impact_count",
)


@_serialized
@lru_cache(maxsize=4096)
def load_task_event_counts(exploration_session_id: int, split_t_s: Optional[float]) -> Dict[str, Any]:
    """Stops, border crossings and landmark impacts of one exploration
    recording, counted separately for its two tasks. Same events as the
    whole-recording counts; an event belongs to task 1 when it STARTS at or
    before the marked time, so the two counts always add up to the whole.
    All None when the recording has no marked time."""
    if split_t_s is None:
        return {k: None for k in TASK_EVENT_KEYS}
    row = get_sessions_df().iloc[int(exploration_session_id)]
    config = extract_config(load_json_cached(str(row["file_path"])))
    tracking_df = load_tracking_df(row["file_path"])
    speed_df = compute_speed_df(tracking_df, seeker_id=config["seeker_id"], rolling_window=settings.speed_rolling_window)
    impacts = [
        ev for ev in compute_imu_quality(tracking_df, config["seeker_id"], config["target_ids"]).get("events", [])
        if ev.get("tag_id") in config["target_ids"]
    ]
    events = {
        "stop_count": compute_stop_events(speed_df)["events"],
        "border_reached_count": compute_border_events(tracking_df, config["seeker_id"], compute_room_bbox(config["anchors"]))["events"],
        "impact_count": impacts,
    }
    out: Dict[str, Any] = {}
    for name, items in events.items():
        in_task1 = sum(1 for ev in items if ev.get("t_s") is not None and ev["t_s"] <= split_t_s)
        out[f"task1_{name}"] = in_task1
        out[f"task2_{name}"] = len(items) - in_task1
    # Closest distance reached to any landmark unit during task 1.
    dist_df = compute_distances(tracking_df, seeker_id=config["seeker_id"], target_ids=config["target_ids"])
    out["task1_min_closest_distance_m"] = None
    if not dist_df.empty:
        task1_dist = pd.to_numeric(dist_df.loc[dist_df["t_s"] <= split_t_s, "distance"], errors="coerce").dropna()
        if not task1_dist.empty:
            out["task1_min_closest_distance_m"] = float(task1_dist.min())
    feedback_df = session_to_feedback_df(load_json_cached(str(row["file_path"])))
    if not feedback_df.empty:
        feedback_df = feedback_df[feedback_df["t_s"] <= split_t_s]
    out.update(compute_approach_depth(feedback_df, config["distance_cfg"]))
    return out


def compute_approach_depth(feedback_df: pd.DataFrame, distance_cfg: Dict[str, Any]) -> Dict[str, Any]:
    """How far into the feedback zone of each landmark the seeker went, read
    from the feedback_changed events (what the participant actually felt or
    heard), not from the tracked positions.

    The feedback changes in steps of `threshold` meters, from
    max_activation_distance (first, weakest step) down to
    settings.feedback_innermost_step_m (last, strongest step). For every
    landmark that gave feedback:
    depth = 100 * steps crossed after the first one / steps available.
    0 = never went past the first step, 100 = reached the strongest one.
    Landmarks that gave no feedback are left out (they are already counted by
    "targets found").

    task1_target_feedback_depth_pct: {target_id: depth}.
    task1_approach_depth_pct: mean depth over those landmarks.
    """
    out = _approach_depth_summary({})
    try:
        d_min = float(distance_cfg.get("min_activation_distance"))
        d_max = float(distance_cfg.get("max_activation_distance"))
        step = float(distance_cfg.get("threshold"))
    except (TypeError, ValueError):
        return out
    if step <= 0 or feedback_df is None or feedback_df.empty or "bucket" not in feedback_df:
        return out
    steps_available = int(round((d_max - settings.feedback_innermost_step_m) / step))
    if steps_available < 1:
        return out
    # Bucket numbers count the steps from min_activation_distance outwards.
    innermost_bucket = int(round((settings.feedback_innermost_step_m - d_min) / step)) - 1
    outermost_bucket = innermost_bucket + steps_available
    depths: Dict[str, float] = {}
    for tid, g in feedback_df.groupby("target_id"):
        buckets = pd.to_numeric(g["bucket"], errors="coerce").dropna()
        if buckets.empty:
            continue
        crossed = int(np.clip(outermost_bucket - buckets.min(), 0, steps_available))
        depths[tid] = 100.0 * crossed / steps_available
    return _approach_depth_summary(depths)


def _approach_depth_summary(depths: Dict[str, float]) -> Dict[str, Any]:
    values = list(depths.values())
    return {
        "task1_target_feedback_depth_pct": depths,
        "task1_approach_depth_pct": float(np.mean(values)) if values else None,
    }


def compute_approach_depth_from_positions(
    task1_xy: pd.DataFrame, patch_coords: Dict[str, List[float]], distance_cfg: Dict[str, Any],
) -> Dict[str, Any]:
    """Same measure and same step scale as compute_approach_depth, for
    haptic_on_object: only P1 is tracked there and the recording carries no
    usable feedback events or landmark positions, so the depth comes from how
    close the seeker's own position (task1_xy) got to each patch coordinate
    (protocol position of the route's landmarks, see PROTOCOL_LANDMARKS). A patch counts once P1 came within
    max_activation_distance of it (where its feedback starts)."""
    try:
        d_max = float(distance_cfg.get("max_activation_distance"))
        step = float(distance_cfg.get("threshold"))
    except (TypeError, ValueError):
        return _approach_depth_summary({})
    steps_available = int(round((d_max - settings.feedback_innermost_step_m) / step)) if step > 0 else 0
    if steps_available < 1 or task1_xy is None or task1_xy.empty:
        return _approach_depth_summary({})
    px, py = task1_xy["x"].to_numpy(), task1_xy["y"].to_numpy()
    depths: Dict[str, float] = {}
    for tid, xy in patch_coords.items():
        closest = float(np.hypot(px - xy[0], py - xy[1]).min())
        if closest > d_max:
            continue
        crossed = int(np.clip(np.floor((d_max - closest) / step), 0, steps_available))
        depths[tid] = 100.0 * crossed / steps_available
    return _approach_depth_summary(depths)


@_serialized
@lru_cache(maxsize=2048)
def load_target_sensor_proximity(exploration_session_id: int, split_t_s: Optional[float] = None) -> Dict[str, float]:
    """Closest geometric distance the seeker ever got to EACH sensor-tracked
    target individually, cached — like load_exploration_movement_events and
    load_session_metrics, compute_distances' full merge over the tracking
    data is too expensive to redo on every /api/trials/compare request for
    every trial (this was previously uncached and dominated that endpoint's
    response time on every call, not just the first cold one).

    Only covers targets with their own sensor; manually-entered coordinates
    aren't cacheable (a newly-entered one must show up immediately) — see
    compute_target_proximity, which merges this with the live manual
    fallback.

    With split_t_s, only task 1 (up to the marked point E) counts, since the
    landmarks belong to task 1.
    """
    sessions_df = get_sessions_df()
    row = sessions_df.iloc[int(exploration_session_id)]
    data = load_json_cached(str(row["file_path"]))
    config = extract_config(data)
    tracking_df = load_tracking_df(row["file_path"])
    dist_df = compute_distances(tracking_df, seeker_id=config["seeker_id"], target_ids=config["target_ids"])
    if split_t_s is not None and not dist_df.empty:
        dist_df = dist_df[dist_df["t_s"] <= split_t_s]
    result: Dict[str, float] = {}
    if not dist_df.empty:
        for tid, g in dist_df.groupby("target_id"):
            d = pd.to_numeric(g["distance"], errors="coerce").dropna()
            if not d.empty:
                result[tid] = float(d.min())
    return result


def compute_target_proximity(
    exploration_session_id: int,
    exp_xy: Optional[pd.DataFrame] = None,
    manual_coords: Optional[Dict[str, List[float]]] = None,
    split_t_s: Optional[float] = None,
) -> Dict[str, float]:
    """Closest geometric distance the seeker ever got to EACH target
    individually — one entry per target this path has a coordinate for,
    keyed by target_id (e.g. "O1"). Deliberately NOT the same thing as
    min_closest_distance (session metric)/closest_df, which at every instant
    keep only whichever target happens to be nearest right then: a trial that
    walked right up to O1 but never near O2/O3 reads as "very close" there,
    while this returns three separate numbers so a per-target average (see
    compute_performance_score and compute_navigation_metrics, which both use
    it) actually reflects all of them, not just the best one.

    Falls back to a straight-line distance against a manually-entered
    coordinate (see apply_manual_target_coords) for any target never tracked
    by its own sensor (e.g. haptic_on_object_intes, which only tracked P1) —
    same fallback source, just min distance instead of a found/not-found
    threshold. The manual part is computed live (not cached), same as
    apply_manual_target_coords, so a coordinate entered a moment ago shows up
    immediately.
    """
    result = dict(load_target_sensor_proximity(exploration_session_id, split_t_s))
    if split_t_s is not None and exp_xy is not None and not exp_xy.empty:
        exp_xy = exp_xy[exp_xy["t_s"] <= split_t_s]  # task 1 only, as above
    if manual_coords and exp_xy is not None and not exp_xy.empty:
        ex, ey = exp_xy["x"].to_numpy(), exp_xy["y"].to_numpy()
        for tid, xy in manual_coords.items():
            if tid in result:
                continue  # sensor-tracked distance already computed above is the more direct measurement
            result[tid] = float(np.hypot(ex - xy[0], ey - xy[1]).min())
    return result


def _linear_good_bad_score(value: Optional[float], good: float, bad: float) -> Optional[float]:
    """1.0 at/below `good`, 0.0 at/above `bad`, linear in between — `good` must
    be < `bad`, which holds for every measure this scores (a smaller distance
    or fewer border crossings is always the better outcome)."""
    if value is None or not np.isfinite(value):
        return None
    if value <= good:
        return 1.0
    if value >= bad:
        return 0.0
    return float((bad - value) / (bad - good))


def compute_performance_score(
    stop_position_distance_m: Optional[float],
    target_proximities_m: Dict[str, float],
    target_found: Dict[str, bool],
    found_count: Optional[int],
    found_total: Optional[int],
    border_reached_count: Optional[int],
) -> Dict[str, Any]:
    """1-5 performance rating for one exploration attempt, built from exactly
    the measures the researcher framed as "task success": how close the
    attempt ended up to the learning route's own end point, how close it got
    to EACH target (O1-On) individually and how many of them were actually
    found, and how many times it left the 8x6 m safety border (a penalty even
    for an attempt that otherwise finished).

    "Target proximity" and "Targets found" are deliberately two separate
    components, not one: proximity is a continuous geometric distance (can
    still be scored even if feedback never fired), found_count/found_total is
    the discrete "did the feedback/manual-distance check actually register
    it" outcome (see target_discovery) — related but not redundant, since a
    target can be walked past just outside the activation radius (close by
    distance, not "found") or found via a delayed/edge-case trigger.

    Each measure is scored 1 (good) to 0 (bad) via _linear_good_bad_score
    using the performance_* reference constants in settings (found_count/
    found_total is already a 0-1 fraction, used as-is), then blended by fixed
    weights (endpoint 0.30 / target proximity 0.25 / targets found 0.25 /
    border 0.20) into a single 0-1 composite, mapped onto 1-5
    (round(1 + 4*composite)).

    This is a heuristic index, NOT a validated measure from the literature —
    the weights and good/bad thresholds are reasonable defaults, not
    calibrated against expert judgment or outcome data. compute_navigation_metrics
    (below) reports the same underlying facts as individually-established
    O&M/wayfinding measures instead, with no combining/weighting, for
    comparison against this composite.

    Speed and peak acceleration are intentionally absent from this formula:
    see compute_speed_accel_correlations, computed across the whole dataset,
    which is the actual check for whether they relate to outcome at all.

    A measure with no data at all (e.g. no target ever tracked for this
    condition and no manual coordinate entered) is dropped and the remaining
    weights renormalized, rather than counting as a 0. Returns score=None (no
    line shown) only if every measure is missing.
    """
    endpoint_score = _linear_good_bad_score(
        stop_position_distance_m, settings.performance_endpoint_good_m, settings.performance_endpoint_bad_m
    )

    per_target_scores = {
        tid: _linear_good_bad_score(d, settings.performance_target_good_m, settings.performance_target_bad_m)
        for tid, d in target_proximities_m.items()
    }
    valid_target_scores = [s for s in per_target_scores.values() if s is not None]
    target_score = float(np.mean(valid_target_scores)) if valid_target_scores else None
    target_mean_raw = float(np.mean(list(target_proximities_m.values()))) if target_proximities_m else None

    found_score = (found_count / found_total) if found_total else None

    border_score = _linear_good_bad_score(
        float(border_reached_count) if border_reached_count is not None else None,
        0.0, float(settings.performance_border_bad_count),
    )
    components = [
        ("Endpoint proximity", endpoint_score, settings.performance_weight_endpoint, stop_position_distance_m, "m"),
        ("Target proximity (avg of O1-On)", target_score, settings.performance_weight_target, target_mean_raw, "m"),
        ("Targets found", found_score, settings.performance_weight_found, found_count, f"of {found_total}" if found_total else ""),
        ("Border crossings", border_score, settings.performance_weight_border, border_reached_count, "crossings"),
    ]
    available = [c for c in components if c[1] is not None]
    if not available:
        return {"score": None, "composite": None, "components": [], "target_breakdown": []}
    weight_sum = sum(w for _, _, w, _, _ in available)
    composite = sum(score * w for _, score, w, _, _ in available) / weight_sum
    score_1_5 = max(1, min(5, int(round(1 + composite * 4))))
    return {
        "score": score_1_5,
        "composite": round(composite, 3),
        "components": [
            {
                "name": name,
                "normalized_score": round(score, 3),
                "weight": round(weight / weight_sum, 3),
                "raw_value": _jsonable(raw),
                "unit": unit,
            }
            for name, score, weight, raw, unit in available
        ],
        # Per-target breakdown behind the "Target proximity" component above —
        # exactly "how close did it get to O1 / O2 / O3 individually", shown
        # in the info popover rather than collapsed into the averaged score.
        "target_breakdown": [
            {
                "target_id": tid,
                "distance_m": round(d, 3),
                "normalized_score": round(per_target_scores[tid], 3) if per_target_scores.get(tid) is not None else None,
                "found": bool(target_found.get(tid, False)),
            }
            for tid, d in sorted(target_proximities_m.items())
        ],
    }


def compute_navigation_metrics(
    ideal_path_length_m: Optional[float],
    actual_path_length_m: Optional[float],
    stop_position_distance_m: Optional[float],
    target_proximities_m: Dict[str, float],
    target_found: Dict[str, bool],
    found_count: Optional[int],
    found_total: Optional[int],
    border_reached_count: Optional[int],
) -> Dict[str, Any]:
    """Standard individual navigation outcome measures for one exploration
    attempt, reported separately rather than combined into a single
    composite score — shown alongside compute_performance_score's 1-5 rating
    (not in place of it) so the two can be compared: that rating is a
    heuristic, weighted-by-guesswork index, while every measure below is
    reported in its own natural unit with no weighting at all. Provenance
    varies per measure — see each one below; not all are verified as named
    O&M/blind-mobility-specific terms, just because they're reported here
    alongside ones that are closer to that domain.

    - path_efficiency_pct: ideal_path_length_m (shortest possible route,
      straight line start -> O1 -> O2 -> O3 -> stop, in visit order — see
      compute_trial_metrics) divided by the actual distance traveled, as a
      percentage. This exact ratio (ideal/actual) is "path efficiency" in
      Morris water maze spatial-navigation research (rodent studies); human
      wayfinding research uses the inverse ("path ratio" = actual/ideal,
      e.g. Fu et al. 2024, PMC11189867). 100% is as short as geometrically
      possible, lower means more backtracking/wandering. Doesn't account for
      time, target proximity, or heading accuracy — only total distance
      covered.
    - target_acquisition_pct / targets_found / targets_total: fraction of
      this path's targets actually found (feedback or manual-distance
      confirmed — see target_discovery). The standard task-success-rate
      measure in search / assistive-technology studies. A target walked past
      just outside the activation radius counts as NOT found here, even if
      target_breakdown below shows it was geometrically close.
    - endpoint_error_m: distance between the exploration's final tracked
      position and the learning trajectory's own end point (the intended
      goal location) — the same "homing error" measure used in classic
      homing / triangle-completion navigation experiments. Only the final
      position matters, not the route taken to reach it.
    - boundary_contacts: number of times the 8x6 m safety perimeter was left
      — analogous to "veering incidents" / obstacle-contact counts reported
      in O&M mobility research on blind pedestrian travel. Counts episodes,
      not how far or how long each excursion was.

    target_breakdown (distance to each target individually, with its own
    found/not-found flag) is included as supporting detail behind
    target_acquisition_pct — descriptive, not itself a scored/weighted
    measure.

    Any measure with no data (e.g. no target ever tracked for this condition
    and no manual coordinate entered) is simply None/omitted — nothing here
    is estimated or backfilled.
    """
    path_efficiency_pct = (
        round(100.0 * ideal_path_length_m / actual_path_length_m, 1)
        if ideal_path_length_m is not None and actual_path_length_m
        else None
    )
    target_acquisition_pct = round(100.0 * found_count / found_total, 1) if found_total else None
    return {
        "path_efficiency_pct": path_efficiency_pct,
        "ideal_path_length_m": _jsonable(round(ideal_path_length_m, 2) if ideal_path_length_m is not None else None),
        "actual_path_length_m": _jsonable(round(actual_path_length_m, 2) if actual_path_length_m is not None else None),
        "target_acquisition_pct": target_acquisition_pct,
        "targets_found": found_count,
        "targets_total": found_total,
        "endpoint_error_m": _jsonable(stop_position_distance_m),
        "boundary_contacts": border_reached_count,
        # Distance to each target individually — the detail behind
        # target_acquisition_pct above (see docstring).
        "target_breakdown": [
            {
                "target_id": tid,
                "distance_m": round(d, 3),
                "found": bool(target_found.get(tid, False)),
            }
            for tid, d in sorted(target_proximities_m.items())
        ],
    }


@lru_cache(maxsize=1)
def compute_speed_accel_correlations() -> Dict[str, Any]:
    """Standalone diagnostic: Pearson correlation, across every trial in the
    dataset with both a learning and exploration recording, between how the
    participant moved (mean walking speed, peak IMU acceleration on the
    seeker tag) and the standard outcome measures in compute_navigation_metrics
    — distance to the learning route's own end point, average distance to
    EACH target individually (same per-target metric compute_navigation_metrics
    uses, not just whichever target happened to be nearest), fraction of
    targets actually found, and border crossings.

    Purely descriptive — answers "does moving faster/more erratically relate
    to how the attempt turned out?" across the whole dataset. Not used to
    weight or adjust any of the navigation metrics above (they're reported
    individually, unweighted — see compute_navigation_metrics' docstring for
    why). Cached (cleared by /api/refresh) since it scans the whole dataset —
    expensive to redo per request, and the answer doesn't change between two
    dropdown clicks.

    Target discovery here is feedback-only (doesn't re-apply per-patient
    manual target coordinates the way compare_trials does) — a reasonable
    simplification for a dataset-wide diagnostic that only affects the small
    number of trials under the haptic_on_object_intes condition.

    Trials flagged "excluded from statistics" (hardware error / bad trial)
    are skipped — a descriptive dataset-wide statistic shouldn't be built on
    data already marked untrustworthy.
    """
    trials_df = build_trials_df()
    if trials_df.empty:
        return {"n": 0, "correlations": {}}
    sessions_df = get_sessions_df()
    speeds: List[float] = []
    accels: List[float] = []
    endpoints: List[float] = []
    targets: List[float] = []
    founds: List[float] = []
    borders: List[float] = []
    for _, r in trials_df.iterrows():
        if pd.isna(r["learning_session_id"]) or pd.isna(r["exploration_session_id"]):
            continue
        learning_id = int(r["learning_session_id"])
        exploration_id = int(r["exploration_session_id"])
        annotation = get_annotation(r["patient"], r["condition"], r["path_id"], exploration_id)
        if annotation.get("excluded_from_stats"):
            continue
        try:
            trial_metrics = load_trial_metrics(learning_id, exploration_id, *trial_split_times(learning_id, exploration_id))
            session_metrics = load_session_metrics(exploration_id)
            events = load_exploration_movement_events(exploration_id)
            target_proximities = compute_target_proximity(exploration_id, split_t_s=trial_split_times(learning_id, exploration_id)[1])
        except Exception:
            continue
        speed = session_metrics.get("mean_speed_m_s")
        accel = session_metrics.get("max_accel_norm")
        endpoint = trial_metrics.get("stop_position_distance_m")
        if speed is None or accel is None or endpoint is None:
            continue
        speeds.append(speed)
        accels.append(accel)
        endpoints.append(endpoint)
        targets.append(float(np.mean(list(target_proximities.values()))) if target_proximities else np.nan)
        target_discovery = trial_metrics.get("target_discovery")
        founds.append(
            target_discovery["found_count"] / len(target_discovery["targets"])
            if target_discovery and target_discovery["targets"] else np.nan
        )
        borders.append(events.get("border_reached_count", np.nan))

    def _corr(a: List[float], b: List[float]) -> Optional[float]:
        av, bv = np.array(a, dtype=float), np.array(b, dtype=float)
        mask = np.isfinite(av) & np.isfinite(bv)
        if mask.sum() < 3 or np.std(av[mask]) == 0 or np.std(bv[mask]) == 0:
            return None
        return float(np.corrcoef(av[mask], bv[mask])[0, 1])

    return {
        "n": len(speeds),
        "correlations": {
            "speed_vs_endpoint_distance": _corr(speeds, endpoints),
            "speed_vs_target_distance": _corr(speeds, targets),
            "speed_vs_targets_found": _corr(speeds, founds),
            "speed_vs_border_crossings": _corr(speeds, borders),
            "accel_vs_endpoint_distance": _corr(accels, endpoints),
            "accel_vs_target_distance": _corr(accels, targets),
            "accel_vs_targets_found": _corr(accels, founds),
            "accel_vs_border_crossings": _corr(accels, borders),
        },
    }


# The four recorded conditions are a full 2x2 factorial — feedback Modality
# (auditory/haptic) x delivery Location (on_object/on_person) — each patient
# experiences all 4 (within-subject), each tied to 2 of the 8 paths. Path
# itself is NOT a usable ANOVA factor: it's nested inside condition (every
# condition owns its own fixed pair of paths), not crossed with it.
def _condition_factors(condition: str) -> Tuple[str, str]:
    c = str(condition)
    modality = "haptic" if c.startswith("haptic") else "auditory"
    location = "on_object" if "on_object" in c else "on_person"
    return modality, location


# Starting set of dependent variables for the 2-way repeated-measures ANOVA
# below, picked for being continuous-ish, already reported per-trial
# elsewhere in the app, and NOT requiring a learning-phase counterpart (see
# compute_anova_results' docstring for why phase isn't a 3rd factor here).
# boundary_contacts/targets_found-as-count are deliberately left out for now
# — they're low-count data that likely violates the normality assumption
# ANOVA relies on; a Poisson/ordinal model would suit them better.
# (dv key, label, source, group). group = which part of the trial the
# measure describes: task 1 (route S -> E, up to the marked point), task 2
# (walk back E -> S, from the marked point) or the whole recording. The
# per-task measures need the manually marked points and stay out of the test
# for any trial where they are missing.
ANOVA_DV_SPECS: List[Tuple[str, str, Optional[str], str]] = [
    # path_efficiency_pct deliberately excluded: its "ideal" denominator is
    # just the learning trajectory's own noisy recorded endpoint (see
    # ideal_stop_xy in compute_trial_metrics), not a protocol-defined
    # coordinate — a genuine return-to-start leg, if the task has one,
    # isn't modeled at all. Not reliable enough for a per-condition
    # statistical comparison until that's fixed.
    ("endpoint_error_m", "End-point distance (m)", "nav_metrics", "task1"),
    ("dtw_distance_m", "Trajectory distance, DTW (m)", None, "task1"),
    ("exploration_task1_length_m", "Trajectory length (m)", None, "task1"),
    ("exploration_task1_duration_s", "Duration (s)", None, "task1"),
    ("exploration_task1_speed_m_s", "Walking speed (m/s)", None, "task1"),
    ("exploration_task1_length_change_m", "Trajectory length change from learning (m)", None, "task1"),
    ("exploration_task1_movement_intensity_m_s2", "Movement intensity (m/s²)", None, "task1"),
    # Time stopped rather than the number of stops: a count this low is a poor
    # fit for an ANOVA (see the note above), seconds less so.
    ("exploration_task1_pause_duration_s", "Pause duration (s)", None, "task1"),
    # A count with many zeros, kept for task 1 only (too few in task 2) and
    # flagged as such on its card: read the test with caution.
    ("exploration_task1_border_reached_count", "Border crossings (count)", None, "task1"),
    ("exploration_task1_approach_depth_pct", "Approach depth (%)", None, "task1"),
    ("return_to_start_distance_m", "Return distance (m)", None, "task2"),
    ("dtw_task2_distance_m", "Trajectory distance, DTW (m)", None, "task2"),
    ("exploration_task2_length_m", "Trajectory length (m)", None, "task2"),
    ("exploration_task2_duration_s", "Duration (s)", None, "task2"),
    ("exploration_task2_speed_m_s", "Walking speed (m/s)", None, "task2"),
    ("exploration_task2_length_change_m", "Trajectory length change from learning (m)", None, "task2"),
    ("exploration_task2_movement_intensity_m_s2", "Movement intensity (m/s²)", None, "task2"),
    # Duration only: the task-2 pause count is too low for an ANOVA, the time
    # stopped is of the same size as in task 1.
    ("exploration_task2_pause_duration_s", "Pause duration (s)", None, "task2"),
    ("exploration_task2_border_reached_count", "Border crossings (count)", None, "task2"),
    ("target_acquisition_pct", "Landmarks reached within 1.0 m (%)", "nav_metrics", "whole"),
    ("target_within_05m_pct", "Landmarks reached within 0.5 m (%)", None, "whole"),
]


@lru_cache(maxsize=1)
def compute_anova_results() -> Dict[str, Any]:
    """Two-way repeated-measures ANOVA (statsmodels' AnovaRM) per dependent
    variable in ANOVA_DV_SPECS, factors Modality (auditory/haptic) x Location
    (on_object/on_person) x Patient (subject, within-subject on both factors)
    — the dataset's actual experimental design (see _condition_factors).

    Phase (learning/exploration) is deliberately NOT a 3rd factor: every DV
    here (path efficiency, homing error, target acquisition, performance
    score) is defined only for an exploration attempt relative to its own
    learning baseline — there's no independent "learning" value of the same
    measure to contrast it against, so phase can't be crossed with the other
    two factors the way a real repeated measure would need.

    Per (patient, condition, path) cell: reuses compare_trials' output (same
    metrics, same manual-override handling as every other panel) and keeps
    the latest attempt that is NOT "excluded from statistics" — if the very
    latest retry was excluded, this falls back to the most recent valid one
    before it, rather than dropping the whole cell. Same convention as the
    frontend's validTrialRows (used by "Route shape by condition" and
    everywhere else on this page), so patient/n counts here stay consistent
    with the rest of General statistics — NOT the same convention as
    trials_summary_by_patient (which drops the cell outright when only its
    own latest attempt is excluded). The two paths of one condition are then
    averaged into a single (patient, condition) cell, since AnovaRM needs
    exactly one value per subject per design cell.

    "Complete cases only", per DV: a patient only enters a DV's ANOVA if
    they have a usable value in ALL 4 conditions for that DV (e.g. a patient
    missing haptic_on_object data entirely would otherwise unbalance the
    design) — same reasoning as the "Complete cases only" toggle elsewhere
    in General statistics, just mandatory here since AnovaRM requires a
    fully balanced design (no missing cells) to run at all.

    Opted-out patients (patient_inclusion) are excluded up front, same as
    every other General-statistics number. Cached (cleared by /api/refresh).

    A DV with fewer than 4 complete-case patients, or a dataset that doesn't
    resolve to exactly the expected 4 conditions, is reported with
    insufficient_data=True instead of a (meaningless/unstable) ANOVA table.
    """
    rows = compare_trials(include_suspicious=True)
    if not rows:
        return {"dvs": []}

    inclusion = load_inclusion()
    # Participants left out of the quantitative statistics for data quality
    # (stats_exclusions.json: pilot, frozen positions); still in the dashboard.
    stats_excluded = load_stats_exclusions()
    # Latest NON-excluded attempt per (patient, condition, path_id) — rows
    # come out of compare_trials grouped by that same key and chronologically
    # ordered within it (see build_trials_df), so the last assignment below
    # is always the most recent attempt that qualifies. See the convention
    # note in the docstring above.
    latest_cell: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for r in rows:
        if inclusion.get(r["patient"], True) is False or r["patient"] in stats_excluded:
            continue
        if r.get("excluded_from_stats") or r.get("exploration_session_id") is None:
            continue
        latest_cell[(r["patient"], r["condition"], r["path_id"])] = r

    all_conditions = sorted({c for _, c, _ in latest_cell.keys()})

    dv_results: List[Dict[str, Any]] = []
    for dv_key, dv_label, source, dv_group in ANOVA_DV_SPECS:
        per_patient_condition: Dict[Tuple[str, str], List[float]] = defaultdict(list)
        for (patient, condition, _path_id), r in latest_cell.items():
            if source == "nav_metrics":
                nm = r.get("nav_metrics")
                value = nm.get(dv_key) if nm else None
            else:
                value = r.get(dv_key)
            if value is not None:
                per_patient_condition[(patient, condition)].append(float(value))

        cell_value: Dict[Tuple[str, str], float] = {
            key: float(np.mean(values)) for key, values in per_patient_condition.items() if values
        }
        patients = sorted({p for p, _ in cell_value.keys()})
        complete_patients = [p for p in patients if all((p, c) in cell_value for c in all_conditions)]

        if len(all_conditions) != 4 or len(complete_patients) < 4:
            dv_results.append({
                "dv": dv_key, "label": dv_label, "group": dv_group, "n_patients": len(complete_patients),
                "conditions": all_conditions, "insufficient_data": True,
            })
            continue

        cell_means = {}
        for condition in all_conditions:
            values = [cell_value[(p, condition)] for p in complete_patients]
            modality, location = _condition_factors(condition)
            cell_means[condition] = {
                "modality": modality, "location": location,
                "mean": float(np.mean(values)),
                "sd": float(np.std(values, ddof=1)) if len(values) > 1 else None,
                "n": len(values),
            }

        # Reference only (not tested): the LEARNING recording's own value of the
        # same per-task measure, for the same patients and trials.
        learning_cell_means = None
        if dv_key.startswith("exploration_") and dv_key[len("exploration_"):] in (*TASK_SEGMENT_KEYS, *PAUSE_METRIC_KEYS):
            learning_key = "learning_" + dv_key[len("exploration_"):]
            learning_values: Dict[Tuple[str, str], List[float]] = defaultdict(list)
            # Percent change vs learning, computed trial by trial:
            # 100 * (exploration - learning) / learning.
            change_values: Dict[Tuple[str, str], List[float]] = defaultdict(list)
            for (patient, condition, _path_id), r in latest_cell.items():
                if r.get(dv_key) is not None and r.get(learning_key) is not None:
                    learning_values[(patient, condition)].append(float(r[learning_key]))
                    if float(r[learning_key]) > 0:
                        change_values[(patient, condition)].append(100.0 * (float(r[dv_key]) - float(r[learning_key])) / float(r[learning_key]))
            learning_cell_means = {}
            for condition in all_conditions:
                values = [float(np.mean(learning_values[(p, condition)])) for p in complete_patients if learning_values.get((p, condition))]
                changes = [float(np.mean(change_values[(p, condition)])) for p in complete_patients if change_values.get((p, condition))]
                learning_cell_means[condition] = {
                    "mean": float(np.mean(values)) if values else None,
                    "sd": float(np.std(values, ddof=1)) if len(values) > 1 else None,
                    "n": len(values),
                    "change_pct_mean": float(np.mean(changes)) if changes else None,
                    "change_pct_sd": float(np.std(changes, ddof=1)) if len(changes) > 1 else None,
                }

        # Approach depth only: how many of the same participants, per
        # condition, fall in each of three groups, judged on every landmark
        # that gave them feedback in that condition — "turned" (left at least
        # one at the first step), "partway" (never that, but stopped short of
        # the strongest step at least once), "full" (always reached it).
        # reach_groups, same participants: how many landmarks of their routes
        # in that condition are not marked as found (the same "targets found"
        # as Target acquisition: feedback or manual flag, whole recording) —
        # "none" (all reached), "one", "more" (two or more).
        approach_groups = None
        reach_groups = None
        if dv_key == "exploration_task1_approach_depth_pct":
            landmark_depths: Dict[Tuple[str, str], List[float]] = defaultdict(list)
            landmarks_missed: Dict[Tuple[str, str], int] = defaultdict(int)
            for (patient, condition, _path_id), r in latest_cell.items():
                landmark_depths[(patient, condition)].extend((r.get("exploration_task1_target_feedback_depth_pct") or {}).values())
                target_discovery = r.get("target_discovery")
                if target_discovery:
                    landmarks_missed[(patient, condition)] += len(target_discovery["targets"]) - target_discovery["found_count"]
            approach_groups, reach_groups = {}, {}
            for condition in all_conditions:
                groups = {"turned": 0, "partway": 0, "full": 0}
                reach = {"none": 0, "one": 0, "more": 0}
                for p in complete_patients:
                    depths = landmark_depths[(p, condition)]
                    groups["turned" if min(depths) == 0 else "partway" if min(depths) < 100 else "full"] += 1
                    missed = landmarks_missed[(p, condition)]
                    reach["none" if missed == 0 else "one" if missed == 1 else "more"] += 1
                approach_groups[condition] = groups
                reach_groups[condition] = reach

        long_df = pd.DataFrame([
            {
                "patient": p,
                "modality": _condition_factors(condition)[0],
                "location": _condition_factors(condition)[1],
                "value": cell_value[(p, condition)],
            }
            for p in complete_patients for condition in all_conditions
        ])

        try:
            table = AnovaRM(long_df, depvar="value", subject="patient", within=["modality", "location"]).fit().anova_table
            effect_key = {"modality": "modality", "location": "location", "modality:location": "interaction"}
            effects = {
                effect_key.get(name, name): {
                    "F": float(row["F Value"]),
                    "df_num": float(row["Num DF"]),
                    "df_den": float(row["Den DF"]),
                    "p": float(row["Pr > F"]),
                }
                for name, row in table.iterrows()
            }
            # Counts with many zeros: also a rank-transformed two-way RM ANOVA
            # (all participant x condition means ranked together, average
            # ranks for ties, then the same AnovaRM), as a robustness check.
            rank_effects = None
            if dv_key.endswith("border_reached_count"):
                rank_df = long_df.assign(value=long_df["value"].rank(method="average"))
                rank_table = AnovaRM(rank_df, depvar="value", subject="patient", within=["modality", "location"]).fit().anova_table
                rank_effects = {
                    effect_key.get(name, name): {
                        "F": float(row["F Value"]), "df_num": float(row["Num DF"]),
                        "df_den": float(row["Den DF"]), "p": float(row["Pr > F"]),
                    }
                    for name, row in rank_table.iterrows()
                }
            dv_results.append({
                "dv": dv_key, "label": dv_label, "group": dv_group, "n_patients": len(complete_patients),
                "conditions": all_conditions, "cell_means": cell_means, "effects": effects,
                "rank_effects": rank_effects,
                # One value per participant and condition (the same ones the
                # means are computed from), for distribution plots.
                "cell_values": {
                    condition: [{"patient": p, "value": float(cell_value[(p, condition)])} for p in complete_patients]
                    for condition in all_conditions
                },
                "learning_cell_means": learning_cell_means,
                "approach_groups": approach_groups,
                "reach_groups": reach_groups,
                "insufficient_data": False,
            })
        except Exception as exc:
            dv_results.append({
                "dv": dv_key, "label": dv_label, "group": dv_group, "n_patients": len(complete_patients),
                "conditions": all_conditions, "insufficient_data": True, "error": str(exc),
            })

    # Participants with a valid trial in every condition (the ANOVA sample
    # before the per-measure check), for the page-wide filter of General statistics.
    conditions_by_patient: Dict[str, set] = defaultdict(set)
    for patient, condition, _path_id in latest_cell:
        conditions_by_patient[patient].add(condition)
    complete_participants = sorted(p for p, conds in conditions_by_patient.items() if conds >= set(all_conditions))

    return {
        "dvs": dv_results,
        "mixed_models": _fit_mixed_models(latest_cell),
        "excluded_participants": stats_excluded,
        "complete_participants": complete_participants,
    }


# The three primary measures, fitted trial by trial (see _fit_mixed_models).
MIXED_MODEL_SPECS: List[Tuple[str, str, Optional[str], str]] = [
    ("endpoint_error_m", "End-point distance (m)", "nav_metrics", "task1"),
    ("dtw_distance_m", "Trajectory distance, DTW (m)", None, "task1"),
    ("return_to_start_distance_m", "Return distance (m)", None, "task2"),
]


def _fit_mixed_models(latest_cell: Dict[Tuple[str, str, str], Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Linear mixed model per primary measure: value ~ modality * location,
    with participant and route as random intercepts. Unlike the ANOVA above
    it uses every valid trial of every included participant (no complete-case
    requirement, the two routes of a condition are not averaged).

    Factors are coded -0.5 / +0.5 (auditory / haptic, on object / on person),
    so each main effect is the difference between its two levels averaged
    over the other factor, in the measure's own unit. If the model with both
    random effects cannot be estimated, it falls back to participant only and
    says so.
    """
    import warnings
    from statsmodels.regression.mixed_linear_model import MixedLM

    results: List[Dict[str, Any]] = []
    for dv_key, dv_label, source, dv_group in MIXED_MODEL_SPECS:
        records = []
        for (patient, condition, path_id), r in latest_cell.items():
            value = (r.get("nav_metrics") or {}).get(dv_key) if source == "nav_metrics" else r.get(dv_key)
            if value is None:
                continue
            modality, location = _condition_factors(condition)
            records.append({
                "value": float(value), "patient": patient, "route": r.get("route_id") or path_id, "one": 1,
                "mod": 0.5 if modality == "haptic" else -0.5,
                "loc": 0.5 if location == "on_person" else -0.5,
            })
        base = {"dv": dv_key, "label": dv_label, "group": dv_group, "n_trials": len(records)}
        df = pd.DataFrame(records)
        if df.empty or df["patient"].nunique() < 4:
            results.append({**base, "n_patients": int(df["patient"].nunique()) if not df.empty else 0, "insufficient_data": True})
            continue
        base.update({"n_patients": int(df["patient"].nunique()), "n_routes": int(df["route"].nunique())})

        attempts = [
            ("participant + route", lambda: MixedLM.from_formula(
                "value ~ mod * loc", df, groups="one",
                vc_formula={"patient": "0 + C(patient)", "route": "0 + C(route)"},
            )),
            ("participant", lambda: MixedLM.from_formula("value ~ mod * loc", df, groups="patient")),
        ]
        # Small samples often leave a variance component near zero, where the
        # default optimiser stalls: try a few before giving up on a structure.
        fitted = None
        unconverged = None
        for random_effects, build in attempts:
            for method in ("lbfgs", "bfgs", "powell", "nm"):
                try:
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore")
                        fit = build().fit(reml=True, method=[method])
                except Exception:
                    continue
                if not np.all(np.isfinite(np.asarray(fit.bse_fe, dtype=float))):
                    continue
                if getattr(fit, "converged", True):
                    fitted = (random_effects, fit)
                    break
                unconverged = unconverged or (random_effects, fit)
            if fitted is not None:
                break
        fitted = fitted or unconverged
        if fitted is None:
            results.append({**base, "insufficient_data": True, "error": "the model could not be estimated"})
            continue
        random_effects, fit = fitted
        conf = fit.conf_int()
        names = {"mod": "modality", "loc": "location", "mod:loc": "interaction"}
        effects = {
            out_name: {
                "estimate": float(fit.params[name]),
                "ci_low": float(conf.loc[name, 0]),
                "ci_high": float(conf.loc[name, 1]),
                "p": float(fit.pvalues[name]),
            }
            for name, out_name in names.items()
        }
        results.append({
            **base, "insufficient_data": False, "random_effects": random_effects,
            "converged": bool(getattr(fit, "converged", True)),
            "intercept": float(fit.params["Intercept"]), "effects": effects,
        })
    return results


def compare_trials(
    patients: Optional[List[str]] = None,
    condition: Optional[str] = None,
    path_id: Optional[str] = None,
    include_suspicious: bool = True,
) -> List[Dict[str, Any]]:
    trials_df = build_trials_df()
    if trials_df.empty:
        return []
    df = trials_df.copy()
    if patients:
        df = df[df["patient"].isin(patients)]
    if condition and condition != "all":
        df = df[df["condition"] == condition]
    if path_id and path_id != "all":
        df = df[df["path_id"] == path_id]
    if not include_suspicious:
        df = df[~df["attempt_lost"]]

    sessions_df = get_sessions_df()
    results: List[Dict[str, Any]] = []
    for _, r in df.iterrows():
        learning_id = int(r["learning_session_id"]) if pd.notna(r["learning_session_id"]) else None
        exploration_id = int(r["exploration_session_id"]) if pd.notna(r["exploration_session_id"]) else None
        row_out: Dict[str, Any] = {
            "patient": _jsonable(r["patient"]),
            "condition": _jsonable(r["condition"]),
            "condition_label": _jsonable(r["condition_label"]),
            "path_id": _jsonable(r["path_id"]),
            "learning_session_id": learning_id,
            "exploration_session_id": exploration_id,
            "attempt_number": _jsonable(r["attempt_number"]),
            "total_attempts": _jsonable(r["total_attempts"]),
            "got_lost": bool(r["trial_got_lost"]),
            # Route actually set up (route_overrides.json); path_id stays the
            # file-name letter and the trial's key.
            "route_id": (
                actual_route(str(r["patient"]), str(r["condition"]), str(r["path_id"]))
                if isinstance(r["path_id"], str) else _jsonable(r["path_id"])
            ),
            "learning_pinned": bool(r.get("learning_pinned", False)),
            "exploration_pinned": bool(r.get("exploration_pinned", False)),
        }
        annotation = get_annotation(r["patient"], r["condition"], r["path_id"], exploration_id)
        row_out["manual_lost"] = annotation.get("manual_lost")
        row_out["comment"] = annotation.get("comment") or ""
        row_out["excluded_from_stats"] = bool(annotation.get("excluded_from_stats", False))
        try:
            learning_split_t_s, exploration_split_t_s = trial_split_times(learning_id, exploration_id)
            row_out["learning_split_t_s"] = learning_split_t_s
            row_out["exploration_split_t_s"] = exploration_split_t_s
            metrics = load_trial_metrics(learning_id, exploration_id, learning_split_t_s, exploration_split_t_s)
            row_out.update({k: (v if k == "turns" else _jsonable(v)) for k, v in metrics.items()})

            # Pauses (stay points, compute_stay_point_pauses) and data gaps of P1, whole and
            # per task, for both recordings: {phase}_[task1_|task2_]pause_* /
            # data_gap_*. The previous rule stays in the *stop* fields.
            for prefix, sid, split_t_s in (
                ("learning", learning_id, learning_split_t_s), ("exploration", exploration_id, exploration_split_t_s),
            ):
                pause_metrics = (
                    load_pause_metrics(sid, split_t_s, settings.pause_stay_radius_m, settings.pause_min_duration_s)
                    if sid is not None else {}
                )
                for key in PAUSE_METRIC_KEYS:
                    row_out[f"{prefix}_{key}"] = pause_metrics.get(key)
                # Border crossings (hysteresis rule) whole and per task, and the
                # previous 0.3 s merge rule under *_merge for comparison. The
                # exploration whole / per-task keys are filled further down
                # from the same rule (load_exploration_movement_events,
                # load_task_event_counts).
                border = load_border_counts(sid, split_t_s) if sid is not None else {}
                for key in BORDER_COUNT_KEYS:
                    if prefix == "learning" or key.endswith("_merge"):
                        row_out[f"{prefix}_{key}"] = border.get(key)
                # Time and speed near / away from the landmarks, task 1 (descriptive).
                zone = load_landmark_zone_split(sid, split_t_s) if sid is not None else {}
                for key in LANDMARK_ZONE_KEYS:
                    row_out[f"{prefix}_{key}"] = zone.get(key)
            # Learning approach depth, next to the experimental one (reference only).
            learning_depth = load_learning_approach_depth(learning_id, learning_split_t_s) if learning_id is not None else {}
            row_out["learning_task1_approach_depth_pct"] = learning_depth.get("task1_approach_depth_pct")
            row_out["learning_task1_target_feedback_depth_pct"] = learning_depth.get("task1_target_feedback_depth_pct")

            # Whole-recording and per-task length / duration / speed of both
            # recordings of the trial, in separate fields.
            for prefix, sid, split_t_s in (
                ("learning", learning_id, learning_split_t_s), ("exploration", exploration_id, exploration_split_t_s),
            ):
                whole = load_session_metrics(sid) if sid is not None else {}
                row_out[f"{prefix}_length_m"] = whole.get("total_distance_m")
                row_out[f"{prefix}_duration_s"] = whole.get("duration_s")
                row_out[f"{prefix}_speed_m_s"] = whole.get("mean_speed_m_s")
                row_out[f"{prefix}_movement_intensity_m_s2"] = whole.get("movement_intensity_m_s2")
                segments = load_task_segments(sid, split_t_s) if sid is not None else {}
                for key in TASK_SEGMENT_KEYS:
                    row_out[f"{prefix}_{key}"] = segments.get(key)

            # Change in trajectory length from the learning phase, per task:
            # experimental minus learning length of the same trial (m). None
            # unless both recordings have their split marked.
            for task in ("task1", "task2"):
                exp_len = row_out.get(f"exploration_{task}_length_m")
                learn_len = row_out.get(f"learning_{task}_length_m")
                row_out[f"exploration_{task}_length_change_m"] = (
                    float(exp_len) - float(learn_len) if exp_len is not None and learn_len is not None else None
                )

            if exploration_id is not None:
                exp_row = sessions_df.iloc[exploration_id]
                exp_data = load_json_cached(str(exp_row["file_path"]))
                exp_config = extract_config(exp_data)
                exp_tracking = load_tracking_df(exp_row["file_path"])

                movement_events = load_exploration_movement_events(exploration_id)
                row_out["stop_count"] = movement_events["stop_count"]
                row_out["border_reached_count"] = movement_events["border_reached_count"]

                for key, value in load_task_event_counts(exploration_id, exploration_split_t_s).items():
                    row_out[f"exploration_{key}"] = value

                session_metrics = load_session_metrics(exploration_id)
                row_out["mean_speed_m_s"] = session_metrics.get("mean_speed_m_s")
                row_out["max_accel_norm"] = session_metrics.get("max_accel_norm")
                row_out["min_closest_distance_m"] = session_metrics.get("min_closest_distance")

                # Manual target coordinates aren't cached (unlike load_trial_metrics
                # above), so one entered a moment ago is reflected immediately —
                # no /api/refresh needed. Applied BEFORE the navigation metrics
                # below so "targets found" and per-target proximity both see it.
                manual_coords = get_target_coordinates(r["patient"], r["condition"], r["path_id"])
                exp_xy = None
                if manual_coords and row_out.get("target_discovery") is not None:
                    exp_xy = p1_xy(exp_tracking, exp_config["seeker_id"])
                    # Landmarks belong to task 1: the "within 1 m of the patch" rule too.
                    task1_only = exp_xy[exp_xy["t_s"] <= exploration_split_t_s] if exploration_split_t_s is not None else exp_xy
                    row_out["target_discovery"] = apply_manual_target_coords(row_out["target_discovery"], task1_only, manual_coords)

                # haptic_on_object tracks P1 only: whatever feedback events or
                # O1-O3 positions its recording still carries are leftovers,
                # so its approach depth is redone from P1's position against
                # the protocol position of the route's landmarks (a manually
                # entered coordinate, when there is one, replaces it).
                if _condition_factors(r["condition"]) == ("haptic", "on_object") and exploration_split_t_s is not None:
                    task1_xy = exp_xy if exp_xy is not None else p1_xy(exp_tracking, exp_config["seeker_id"])
                    patch_coords = {**protocol_landmark_coordinates(row_out["route_id"], exp_config["target_ids"]), **manual_coords}
                    depth = compute_approach_depth_from_positions(
                        task1_xy[task1_xy["t_s"] <= exploration_split_t_s], patch_coords, exp_config["distance_cfg"],
                    )
                    for key, value in depth.items():
                        row_out[f"exploration_{key}"] = value

                # Manual found/in-order flags (same "not cached" reasoning as
                # the coordinates above) — always win over whatever the
                # feedback/distance heuristics above just computed.
                manual_discovery_override = get_manual_discovery_override(r["patient"], r["condition"], r["path_id"])
                if row_out.get("target_discovery") is not None:
                    row_out["target_discovery"] = apply_manual_discovery_overrides(row_out["target_discovery"], manual_discovery_override)

                # Share (%) of the route's landmarks reached within 0.5 m in task 1
                # (up to the marked split). AP/AE/HP: closest P1 distance to each
                # unit (load_target_sensor_proximity). HE: a manual found flag is
                # kept (found = reached the 50 cm patch); without a flag, P1 within
                # 0.5 m of the protocol patch position. None without a split or
                # without a distance for every landmark.
                row_out["target_within_05m_pct"] = None
                if exploration_split_t_s is not None and row_out.get("target_discovery") is not None:
                    radius = 0.5
                    targets = row_out["target_discovery"]["targets"]
                    reached: List[bool] = []
                    if _condition_factors(r["condition"]) == ("haptic", "on_object"):
                        exp_xy_all = exp_xy if exp_xy is not None else p1_xy(exp_tracking, exp_config["seeker_id"])
                        task1_xy = exp_xy_all[exp_xy_all["t_s"] <= exploration_split_t_s]
                        patches = protocol_landmark_coordinates(row_out["route_id"], exp_config["target_ids"])
                        for t in targets:
                            flag = t.get("manual_found_override")
                            if flag is not None:
                                reached.append(bool(flag))
                            elif t["target_id"] in patches and not task1_xy.empty:
                                px, py = patches[t["target_id"]]
                                reached.append(bool(np.hypot(task1_xy["x"] - px, task1_xy["y"] - py).min() <= radius))
                            else:
                                reached = []
                                break
                    else:
                        closest = load_target_sensor_proximity(exploration_id, exploration_split_t_s)
                        if all(t["target_id"] in closest for t in targets):
                            reached = [closest[t["target_id"]] <= radius for t in targets]
                    if reached and len(reached) == len(targets):
                        row_out["target_within_05m_pct"] = 100.0 * sum(reached) / len(reached)

                # A trial flagged "excluded from statistics" (hardware error /
                # bad trial — see the Exclude from statistics checkbox) has no
                # trustworthy outcome to report: showing metrics anyway would
                # present numbers the researcher already said not to trust.
                if row_out["excluded_from_stats"]:
                    row_out["performance_score"] = None
                    row_out["performance_score_details"] = None
                    row_out["nav_metrics"] = None
                else:
                    target_discovery = row_out.get("target_discovery")
                    target_proximities = compute_target_proximity(
                        exploration_id, exp_xy=exp_xy, manual_coords=manual_coords, split_t_s=exploration_split_t_s,
                    )
                    target_found = {t["target_id"]: t["found"] for t in target_discovery["targets"]} if target_discovery else {}
                    found_count = target_discovery.get("found_count") if target_discovery else None
                    found_total = len(target_discovery["targets"]) if target_discovery else None

                    row_out["performance_score_details"] = compute_performance_score(
                        row_out.get("stop_position_distance_m"),
                        target_proximities,
                        target_found,
                        found_count,
                        found_total,
                        row_out["border_reached_count"],
                    )
                    row_out["performance_score"] = row_out["performance_score_details"]["score"]

                    row_out["nav_metrics"] = compute_navigation_metrics(
                        row_out.get("ideal_path_length_m"),
                        session_metrics.get("total_distance_m"),
                        row_out.get("stop_position_distance_m"),
                        target_proximities,
                        target_found,
                        found_count,
                        found_total,
                        row_out["border_reached_count"],
                    )
            else:
                row_out["stop_count"] = None
                row_out["border_reached_count"] = None
                row_out["mean_speed_m_s"] = None
                row_out["max_accel_norm"] = None
                row_out["min_closest_distance_m"] = None
                row_out["performance_score"] = None
                row_out["performance_score_details"] = None
                row_out["nav_metrics"] = None
            # Per-landmark approach depth counts, task 1, both phases: landmarks
            # left at the first step (0%), reached to the strongest step (100%),
            # and all landmarks that gave feedback (the denominator; for
            # haptic_on_object, those within reach of the protocol position).
            for prefix in ("learning", "exploration"):
                depths = row_out.get(f"{prefix}_task1_target_feedback_depth_pct")
                values = list(depths.values()) if isinstance(depths, dict) else None
                row_out[f"{prefix}_task1_landmarks_depth0_count"] = None if values is None else sum(1 for v in values if v == 0)
                row_out[f"{prefix}_task1_landmarks_depth100_count"] = None if values is None else sum(1 for v in values if v == 100)
                row_out[f"{prefix}_task1_landmarks_with_feedback_count"] = None if values is None else len(values)
        except Exception as exc:
            row_out["error"] = str(exc)
        results.append(row_out)
    return results


def trials_summary_by_patient(patients: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """Cheap per-patient trial counts (no trajectory computation, just session
    metadata + any manual annotations) — safe to fetch eagerly for every
    patient, e.g. to show "N/M trials lost" on a collapsed dropdown header."""
    trials_df = build_trials_df()
    if trials_df.empty:
        return []
    df = trials_df.copy()
    if patients:
        df = df[df["patient"].isin(patients)]

    annotations = load_annotations()
    results: List[Dict[str, Any]] = []
    for patient, g in df.groupby("patient"):
        total = 0
        lost = 0
        for (condition, path_id), gg in g.groupby(["condition", "path_id"]):
            last = gg.iloc[-1]  # most recent attempt (rows are already chronological)
            exploration_id = int(last["exploration_session_id"]) if pd.notna(last["exploration_session_id"]) else None
            ann = annotations.get(annotation_key(patient, condition, path_id, exploration_id))
            if ann and ann.get("excluded_from_stats"):
                continue  # hardware error / bad trial — don't count it at all
            total += 1
            manual_lost = ann.get("manual_lost") if ann else None
            effective_lost = manual_lost if manual_lost is not None else bool(last["trial_got_lost"])
            if effective_lost:
                lost += 1
        results.append({"patient": patient, "total_trials": total, "lost_trials": lost})
    return sorted(results, key=lambda r: r["patient"])
