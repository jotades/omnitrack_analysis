from __future__ import annotations

import json
from typing import Dict

from .settings import get_settings

settings = get_settings()


def load_stats_exclusions() -> Dict[str, str]:
    """{patient: reason} — participants left out of the quantitative
    statistics (ANOVA and mixed models) for data-quality reasons, while staying
    visible everywhere else in the dashboard. Separate from
    patient_inclusion.json, which hides a participant from General statistics."""
    path = settings.stats_exclusions_path
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
