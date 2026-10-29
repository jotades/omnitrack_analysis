from __future__ import annotations

import json
from typing import Dict

from .settings import get_settings

settings = get_settings()


def pin_key(patient: str, condition: str, path_id: str) -> str:
    return f"{patient}|{condition}|{path_id}"


def load_recording_pins() -> Dict[str, Dict[str, str]]:
    """{"patient|condition|path_id": {"learning": file_name, "exploration": file_name}}
    — which recording a trial uses for each phase, fixed by hand for the
    trials where the automatic choice is the wrong one. Either phase may be
    left out (that one stays automatic). Never touches the raw session files."""
    path = settings.recording_pins_path
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
