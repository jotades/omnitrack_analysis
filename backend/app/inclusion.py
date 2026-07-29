from __future__ import annotations

import json
from typing import Dict

from .settings import get_settings

settings = get_settings()


def load_inclusion() -> Dict[str, bool]:
    path = settings.patient_inclusion_path
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_inclusion(patient: str) -> bool:
    """Patients default to included unless explicitly opted out."""
    return load_inclusion().get(patient, True)


def save_inclusion(patient: str, included: bool) -> Dict[str, bool]:
    data = load_inclusion()
    data[patient] = included
    path = settings.patient_inclusion_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data
