from __future__ import annotations

import json
import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd

from .settings import get_settings

settings = get_settings()

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


def clear_caches() -> None:
    load_json_cached.cache_clear()
    build_sessions_index_cached.cache_clear()
    load_session_metrics.cache_clear()
    load_trial_metrics.cache_clear()


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


@lru_cache(maxsize=4)
def build_sessions_index_cached(base_dir_str: str) -> pd.DataFrame:
    return build_sessions_index(Path(base_dir_str))


def build_sessions_index(base_dir: Path) -> pd.DataFrame:
    rows: List[Dict[str, Any]] = []
    for fp, patient_hint in discover_json_files(base_dir):
        filename_info = parse_filename(fp)
        try:
            data = load_json_cached(str(fp))
        except Exception as exc:
            rows.append({
                "patient": patient_hint or filename_info.get("patient") or "unknown",
                "phase": filename_info.get("phase"),
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
        phase = data.get("task") or filename_info.get("phase") or "unknown"
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
    for sample_idx, rec in enumerate(raw_data):
        ts = pd.to_datetime(rec.get("timestamp"), errors="coerce")
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


def session_to_orientation_df(data: Dict[str, Any]) -> pd.DataFrame:
    """Extract per-sample IMU quaternion yaw (heading) per tag.

    quat_array convention in the recordings is [x, y, z, w] (unit norm).
    Yaw is the rotation around the vertical axis, in degrees, in the same
    x/y frame as the positions.
    """
    rows = []
    raw_data = data.get("raw_data") or []
    for sample_idx, rec in enumerate(raw_data):
        ts = pd.to_datetime(rec.get("timestamp"), errors="coerce")
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


def detect_turns(xy_df: pd.DataFrame) -> List[Dict[str, Any]]:
    """Auto-detect up to 3 turns along a trajectory (used on the learning phase as the
    "ideal"/learned reference — no hardcoded per-path waypoints)."""
    step_m = settings.turn_resample_step_m
    resampled = resample_by_arc_length(xy_df, step_m)
    change = _heading_change_deg(resampled, step_m)
    if len(change) == 0:
        return []
    min_gap_idx = max(1, int(round(settings.turn_min_separation_m / step_m)))
    picks: List[int] = []
    for i in np.argsort(-change):
        if change[i] < settings.min_turn_heading_change_deg:
            break
        if all(abs(int(i) - p) > min_gap_idx for p in picks):
            picks.append(int(i))
        if len(picks) >= 3:
            break
    picks.sort()
    turns = []
    for turn_index, i in enumerate(picks):
        row = resampled.iloc[i]
        turns.append({
            "turn_index": turn_index,
            "s_m": float(row["s_m"]),
            "x": float(row["x"]),
            "y": float(row["y"]),
            "heading_change_deg": float(change[i]),
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


def compute_border_events(tracking_df: pd.DataFrame, seeker_id: str, bbox: Optional[Dict[str, float]]) -> Dict[str, Any]:
    if not bbox or tracking_df is None or tracking_df.empty:
        return {"count": 0, "events": [], "inner_box": None}
    p1 = tracking_df.loc[tracking_df["tag_id"] == seeker_id, ["t_s", "x", "y"]].dropna(subset=["x", "y"]).sort_values("t_s")
    if p1.empty:
        return {"count": 0, "events": [], "inner_box": None}
    x_span = bbox["x_max"] - bbox["x_min"]
    y_span = bbox["y_max"] - bbox["y_min"]
    # Longer anchor-span axis gets the larger margin (e.g. 12 m axis -> 8 m inner span);
    # a square room (tie) falls back to treating y as the long axis.
    if x_span > y_span:
        margin_x, margin_y = settings.border_margin_long_m, settings.border_margin_short_m
    else:
        margin_x, margin_y = settings.border_margin_short_m, settings.border_margin_long_m
    inner = {
        "x_min": bbox["x_min"] + margin_x, "x_max": bbox["x_max"] - margin_x,
        "y_min": bbox["y_min"] + margin_y, "y_max": bbox["y_max"] - margin_y,
    }
    outside = (p1["x"] < inner["x_min"]) | (p1["x"] > inner["x_max"]) | (p1["y"] < inner["y_min"]) | (p1["y"] > inner["y_max"])
    items = [{"t_s": float(t)} for t in p1.loc[outside, "t_s"].dropna().to_numpy()]
    events = merge_events(items, time_key="t_s", gap_s=0.3)
    return {"count": len(events), "events": events, "inner_box": inner}


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
    merged["distance"] = np.sqrt(
        (merged["x"] - merged["p1_x"]) ** 2 +
        (merged["y"] - merged["p1_y"]) ** 2 +
        (merged["z"] - merged["p1_z"]) ** 2
    )
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
    p1["dx"] = p1["x"].diff(); p1["dy"] = p1["y"].diff(); p1["dz"] = p1["z"].diff()
    p1["step_distance"] = np.sqrt(p1["dx"] ** 2 + p1["dy"] ** 2 + p1["dz"] ** 2)
    p1["speed_m_s"] = p1["step_distance"] / p1["dt_s"]
    bad_speed = (p1["dt_s"] <= 0) | (~np.isfinite(p1["speed_m_s"]))
    p1.loc[bad_speed, "speed_m_s"] = np.nan
    p1["speed_m_s_smooth"] = p1["speed_m_s"].rolling(rolling_window, min_periods=1).median()
    return p1[["timestamp", "t_s", "x", "y", "z", "dt_s", "step_distance", "speed_m_s", "speed_m_s_smooth"]]


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
        metrics["mean_speed_m_s"] = _jsonable(pd.to_numeric(speed_df["speed_m_s_smooth"], errors="coerce").mean())
        metrics["max_speed_m_s"] = _jsonable(pd.to_numeric(speed_df["speed_m_s_smooth"], errors="coerce").max())
        metrics["total_distance_m"] = _jsonable(pd.to_numeric(speed_df["step_distance"], errors="coerce").sum())
    if tracking_df is not None and not tracking_df.empty and seeker_id is not None and "accel_norm" in tracking_df.columns:
        seeker_accel = pd.to_numeric(tracking_df.loc[tracking_df["tag_id"] == seeker_id, "accel_norm"], errors="coerce")
        seeker_accel = seeker_accel[seeker_accel > 0]  # zeros = IMU not streaming
        if not seeker_accel.empty:
            metrics["max_accel_norm"] = _jsonable(seeker_accel.max())
    return metrics


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
    tracking_df = session_to_tracking_df(data)
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

    tracking_df = session_to_tracking_df(data)
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
    for _, r in df.iterrows():
        try:
            m = load_session_metrics(int(r["session_id"]))
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
    """
    sessions_df = get_sessions_df()
    if sessions_df.empty:
        return pd.DataFrame()

    rows: List[Dict[str, Any]] = []
    for (patient, condition, path_id), g in sessions_df.groupby(["patient", "condition", "path_id"], dropna=False):
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

        base = {
            "patient": patient, "condition": condition, "condition_label": condition_label, "path_id": path_id,
            "learning_session_id": learning_session_id,
            "learning_reference_flagged": learning_reference_flagged,
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

        for attempt_number, (_, exp_row) in enumerate(exploration.iterrows(), start=1):
            attempt_lost = bool(exp_row["is_interrupt"]) or bool(exp_row["is_suspicious_short"]) or attempt_number < total_attempts
            rows.append({
                **base,
                "exploration_session_id": int(exp_row["session_id"]),
                "attempt_number": attempt_number, "total_attempts": total_attempts,
                "attempt_lost": attempt_lost,
                "trial_got_lost": attempt_lost or learning_is_interrupt,
            })
    return pd.DataFrame(rows)


def compute_trial_metrics(learning_session_id: Optional[int], exploration_session_id: Optional[int]) -> Dict[str, Any]:
    """Compare an exploration trajectory against its trial's learning trajectory:
    route overlap, turn-by-turn deviation, and stop/start position drift."""
    empty = {
        "overlap_pct": None, "mean_deviation_m": None,
        "turns": [], "wrong_turns_count": None, "mean_turn_deviation_deg": None,
        "stop_position_distance_m": None, "start_position_distance_m": None,
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

    learn_xy = p1_xy(session_to_tracking_df(learn_data), learn_config["seeker_id"])
    exp_xy = p1_xy(session_to_tracking_df(exp_data), exp_config["seeker_id"])
    if learn_xy.empty or exp_xy.empty:
        return {**empty, "note": "empty trajectory for learning or exploration session"}

    lx, ly = learn_xy["x"].to_numpy(), learn_xy["y"].to_numpy()
    ex, ey = exp_xy["x"].to_numpy(), exp_xy["y"].to_numpy()

    # Overlap: fraction of exploration points that fall within the buffer distance
    # of the learning trajectory (nearest-neighbor distance, point-wise). Vectorized
    # pairwise distance matrix instead of a Python-level loop: with sessions running
    # into thousands of samples, a per-point loop held the GIL long enough to stall
    # other concurrent requests (e.g. a rapid sequence of dropdown changes).
    min_dist = np.hypot(ex[:, None] - lx[None, :], ey[:, None] - ly[None, :]).min(axis=1)
    overlap_pct = float(100.0 * np.mean(min_dist <= settings.trial_overlap_buffer_m))
    mean_deviation_m = float(min_dist.mean())

    turns = detect_turns(learn_xy)
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
            "learned_heading_change_deg": t["heading_change_deg"],
            "exploration_heading_change_deg": exp_change,
            "deviation_deg": deviation_deg,
            "wrong_turn": wrong_turn,
        })
        if deviation_deg is not None:
            deviations.append(deviation_deg)

    return {
        "overlap_pct": overlap_pct,
        "mean_deviation_m": mean_deviation_m,
        "turns": turn_results,
        "wrong_turns_count": sum(1 for t in turn_results if t["wrong_turn"]),
        "mean_turn_deviation_deg": float(np.mean(deviations)) if deviations else None,
        # Stopping position: how far the exploration end point is from where the
        # participant stopped during learning.
        "stop_position_distance_m": float(math.hypot(lx[-1] - ex[-1], ly[-1] - ey[-1])),
        # "Estimated start" at the end of the trial: exploration's own end point,
        # compared against the learning phase's *start* position (per protocol).
        "start_position_distance_m": float(math.hypot(lx[0] - ex[-1], ly[0] - ey[-1])),
    }


@lru_cache(maxsize=2048)
def load_trial_metrics(learning_session_id: Optional[int], exploration_session_id: Optional[int]) -> Dict[str, Any]:
    return compute_trial_metrics(learning_session_id, exploration_session_id)


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
        }
        try:
            metrics = load_trial_metrics(learning_id, exploration_id)
            row_out.update({k: (v if k == "turns" else _jsonable(v)) for k, v in metrics.items()})

            if exploration_id is not None:
                exp_row = sessions_df.iloc[exploration_id]
                exp_data = load_json_cached(str(exp_row["file_path"]))
                exp_config = extract_config(exp_data)
                exp_tracking = session_to_tracking_df(exp_data)
                speed_df = compute_speed_df(exp_tracking, seeker_id=exp_config["seeker_id"], rolling_window=settings.speed_rolling_window)
                bbox = compute_room_bbox(exp_config["anchors"])
                row_out["stop_count"] = compute_stop_events(speed_df)["count"]
                row_out["border_reached_count"] = compute_border_events(exp_tracking, exp_config["seeker_id"], bbox)["count"]
            else:
                row_out["stop_count"] = None
                row_out["border_reached_count"] = None
        except Exception as exc:
            row_out["error"] = str(exc)
        results.append(row_out)
    return results
