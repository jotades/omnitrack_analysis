from __future__ import annotations

import json
from typing import Any, Dict, Optional

from .settings import get_settings

settings = get_settings()


def annotation_key(patient: str, condition: str, path_id: str, exploration_session_id: Optional[int]) -> str:
    return f"{patient}|{condition}|{path_id}|{exploration_session_id if exploration_session_id is not None else 'none'}"


def load_annotations() -> Dict[str, Dict[str, Any]]:
    path = settings.annotations_path
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_annotation(patient: str, condition: str, path_id: str, exploration_session_id: Optional[int]) -> Dict[str, Any]:
    data = load_annotations()
    return data.get(
        annotation_key(patient, condition, path_id, exploration_session_id),
        {"manual_lost": None, "comment": "", "excluded_from_stats": False},
    )


def save_annotation(
    patient: str,
    condition: str,
    path_id: str,
    exploration_session_id: Optional[int],
    manual_lost: Optional[bool],
    comment: str,
    excluded_from_stats: bool = False,
) -> Dict[str, Any]:
    data = load_annotations()
    key = annotation_key(patient, condition, path_id, exploration_session_id)
    record = {
        "patient": patient,
        "condition": condition,
        "path_id": path_id,
        "exploration_session_id": exploration_session_id,
        "manual_lost": manual_lost,
        "comment": comment,
        "excluded_from_stats": excluded_from_stats,
    }
    data[key] = record
    path = settings.annotations_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return record
