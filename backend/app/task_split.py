from __future__ import annotations

import json
from typing import Any, Dict, Optional

from .settings import get_settings

settings = get_settings()


def load_task_splits() -> Dict[str, Dict[str, Any]]:
    """{file_name: {"t_s": float, "x": float | None, "y": float | None}} —
    the manually marked point E of a recording: where the route to the end
    point finishes and the walk back to the start begins."""
    path = settings.task_split_path
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_task_split(
    file_name: str,
    t_s: Optional[float],
    x: Optional[float] = None,
    y: Optional[float] = None,
) -> Dict[str, Dict[str, Any]]:
    """t_s=None clears the mark for that recording."""
    data = load_task_splits()
    if t_s is None:
        data.pop(file_name, None)
    else:
        data[file_name] = {"t_s": t_s, "x": x, "y": y}
    path = settings.task_split_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data
