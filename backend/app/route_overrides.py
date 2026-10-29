from __future__ import annotations

import json
from typing import Dict

from .settings import get_settings

settings = get_settings()


def load_route_overrides() -> Dict[str, str]:
    """{"patient|condition|path_id": actual route} — the route actually set up,
    for the trials whose file name carries another route letter. path_id (the
    file-name letter) stays the trial's key everywhere; only the landmark
    positions, the mixed model and the displayed route use the actual one."""
    path = settings.route_overrides_path
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def actual_route(patient: str, condition: str, path_id: str) -> str:
    """The route actually set up for this trial (path_id when not overridden).
    Every override is looked up on the file-name letter, so swaps within a
    participant (A -> C and C -> F) apply at the same time, never chained."""
    return load_route_overrides().get(f"{patient}|{condition}|{path_id}", path_id)
