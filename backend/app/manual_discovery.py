from __future__ import annotations

import json
from typing import Any, Dict, Optional

from .settings import get_settings
from .target_coordinates import coord_key

settings = get_settings()


def load_manual_discovery_overrides() -> Dict[str, Dict[str, Any]]:
    """{trial_key: {"targets_found": {target_id: bool}, "in_order": bool | None}}
    — manual override of found/in-order per trial, for when the automatic
    feedback/distance-based detection (see apply_manual_target_coords in
    analysis.py) gets it wrong. Same small-JSON-file pattern as
    target_coordinates.py, same key shape (coord_key)."""
    path = settings.manual_discovery_path
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_manual_discovery_override(patient: str, condition: str, path_id: str) -> Dict[str, Any]:
    data = load_manual_discovery_overrides()
    return data.get(coord_key(patient, condition, path_id), {"targets_found": {}, "in_order": None})


def _save(data: Dict[str, Any]) -> None:
    path = settings.manual_discovery_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def save_manual_target_found(
    patient: str, condition: str, path_id: str, target_id: str, found: Optional[bool]
) -> Dict[str, Any]:
    """found=None clears the override for this target (reverts to automatic detection)."""
    data = load_manual_discovery_overrides()
    key = coord_key(patient, condition, path_id)
    record = dict(data.get(key, {"targets_found": {}, "in_order": None}))
    targets_found = dict(record.get("targets_found") or {})
    if found is None:
        targets_found.pop(target_id, None)
    else:
        targets_found[target_id] = found
    record["targets_found"] = targets_found
    data[key] = record
    _save(data)
    return record


def save_manual_in_order(
    patient: str, condition: str, path_id: str, in_order: Optional[bool]
) -> Dict[str, Any]:
    """in_order=None clears the override (reverts to automatic detection)."""
    data = load_manual_discovery_overrides()
    key = coord_key(patient, condition, path_id)
    record = dict(data.get(key, {"targets_found": {}, "in_order": None}))
    record["in_order"] = in_order
    data[key] = record
    _save(data)
    return record
