from __future__ import annotations

import json
from typing import Dict

from .settings import get_settings

settings = get_settings()


def load_observations() -> Dict[str, str]:
    """{section_key: text} — free-text observations written in the dashboard
    next to a block of results (e.g. "anova")."""
    path = settings.observations_path
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_observation(key: str, text: str) -> Dict[str, str]:
    """An empty text removes the entry."""
    data = load_observations()
    if text.strip():
        data[key] = text
    else:
        data.pop(key, None)
    path = settings.observations_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data
