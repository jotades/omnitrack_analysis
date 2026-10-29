from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from .settings import get_settings

settings = get_settings()


# Protocol position (x, y in meters) of landmark 1, 2 and 3 of each route.
# Used for haptic_on_object only, where the patches are not tracked.
PROTOCOL_LANDMARKS: Dict[str, List[List[float]]] = {
    "path_A": [[6.0, 5.0], [6.0, 7.5], [2.5, 7.5]],
    "path_B": [[6.0, 8.5], [4.0, 8.5], [4.0, 5.5]],
    "path_C": [[2.5, 7.0], [6.0, 7.0], [6.0, 3.5]],
    "path_D": [[6.0, 5.0], [2.0, 5.0], [2.0, 7.5]],
    "path_E": [[6.5, 3.5], [4.0, 3.5], [4.0, 8.0]],
    "path_F": [[3.5, 8.0], [3.5, 3.5], [6.0, 3.5]],
    "path_G": [[1.5, 5.5], [4.5, 5.5], [4.5, 9.5]],
    "path_H": [[4.0, 2.5], [4.0, 6.5], [6.0, 6.5]],
    "path_Z": [[5.5, 7.5], [5.5, 4.0], [2.0, 4.5]],
}


def protocol_landmark_coordinates(path_id: str, target_ids_in_order: List[str]) -> Dict[str, List[float]]:
    """{target_id: [x, y]} — the route's landmarks in protocol order, named
    after the targets in the order the route visits them. Empty for a route
    that is not in the protocol table."""
    return dict(zip(target_ids_in_order, PROTOCOL_LANDMARKS.get(path_id, [])))


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
    x: Optional[float],
    y: Optional[float],
) -> Dict[str, Any]:
    """x or y None removes the coordinate entered for that target."""
    data = load_target_coordinates()
    key = coord_key(patient, condition, path_id)
    record = data.get(key, {})
    if x is None or y is None:
        record.pop(target_id, None)
    else:
        record[target_id] = [x, y]
    if record:
        data[key] = record
    else:
        data.pop(key, None)
    path = settings.target_coordinates_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return record
