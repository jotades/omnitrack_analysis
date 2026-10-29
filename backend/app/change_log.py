from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .settings import get_settings

settings = get_settings()

# Marks a key that did not exist in the file (undo removes it again).
ABSENT = "__absent__"


def _read(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def snapshot(path: Path, keys: List[str]) -> Dict[str, Any]:
    """The current value of each key in a correction file (ABSENT if missing)."""
    data = _read(path)
    return {k: data.get(k, ABSENT) for k in keys}


def record(kind: str, summary: str, path: Optional[Path], keys: List[str], before: Dict[str, Any],
           extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Append one change to the log (corrections_log.jsonl): what was changed,
    the value before and after, and when — so a change can be read back and
    undone. Every save from the dashboard goes through here."""
    entry = {
        "id": uuid.uuid4().hex[:12],
        "time": datetime.now().isoformat(timespec="seconds"),
        "kind": kind,
        "summary": summary,
        "file": str(path) if path is not None else None,
        "keys": keys,
        "before": before,
        "after": snapshot(path, keys) if path is not None else (extra or {}).get("after"),
    }
    if extra:
        entry.update({k: v for k, v in extra.items() if k != "after"})
    log_path = settings.change_log_path
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def list_changes(limit: int = 100) -> List[Dict[str, Any]]:
    """Newest first. An entry that was later undone carries undone_by."""
    path = settings.change_log_path
    if not path.exists():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entries.append(json.loads(line))
        except Exception:
            continue
    undone = {e.get("undo_of"): e["id"] for e in entries if e.get("undo_of")}
    for e in entries:
        if e["id"] in undone:
            e["undone_by"] = undone[e["id"]]
    return list(reversed(entries))[:limit]


def find_change(change_id: str) -> Optional[Dict[str, Any]]:
    return next((e for e in list_changes(10**9) if e["id"] == change_id), None)


def restore_file_keys(entry: Dict[str, Any]) -> None:
    """Write the 'before' values of a logged change back into its file."""
    path = Path(entry["file"])
    data = _read(path)
    for key, value in entry["before"].items():
        if value == ABSENT:
            data.pop(key, None)
        else:
            data[key] = value
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
