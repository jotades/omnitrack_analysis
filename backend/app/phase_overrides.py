from __future__ import annotations

import json
from typing import Dict

from .settings import get_settings

settings = get_settings()


def load_phase_overrides() -> Dict[str, str]:
    """{file_name: "learning" | "exploration"} — corrects a session's phase
    without ever touching the raw session JSON file on disk."""
    path = settings.phase_overrides_path
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_phase_override(file_name: str, phase: str) -> Dict[str, str]:
    data = load_phase_overrides()
    data[file_name] = phase
    path = settings.phase_overrides_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data


def swap_phase_pair(learning_file_name: str, exploration_file_name: str) -> Dict[str, str]:
    """The file currently resolving to "learning" becomes "exploration" and
    vice versa — for the common mistake of the two recordings being started
    in the wrong order/phase at collection time."""
    data = load_phase_overrides()
    data[learning_file_name] = "exploration"
    data[exploration_file_name] = "learning"
    path = settings.phase_overrides_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data
