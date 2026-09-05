from __future__ import annotations

import json
from typing import Any, Dict, List

from .settings import get_settings

settings = get_settings()


def coord_key(patient: str, condition: str, path_id: str) -> str:
    return f"{patient}|{condition}|{path_id}"


def load_target_coordinates() -> Dict[str, Dict[str, List[float]]]:
    path = settings.target_coordinates_path
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_target_coordinates(patient: str, condition: str, path_id: str) -> Dict[str, List[float]]:
    """{target_id: [x, y]} for whichever targets have a manually-entered
    coordinate for this trial — empty dict if none have been entered yet."""
    data = load_target_coordinates()
    return data.get(coord_key(patient, condition, path_id), {})


def save_target_coordinate(
    patient: str,
    condition: str,
    path_id: str,
    target_id: str,
    x: float,
    y: float,
) -> Dict[str, Any]:
    data = load_target_coordinates()
    key = coord_key(patient, condition, path_id)
    record = data.get(key, {})
    record[target_id] = [x, y]
    data[key] = record
    path = settings.target_coordinates_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return record
