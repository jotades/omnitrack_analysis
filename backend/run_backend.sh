#!/usr/bin/env bash
set -euo pipefail
# Started from inside app/: uvicorn's auto-reload always watches the folder it
# is launched from, and watching backend/ would include .venv (tens of
# thousands of files), which hits the system's file-watch limit.
cd "$(dirname "$0")/app"
# Poll for changes instead of using the system file watchers, which VS Code
# keeps almost full (the auto-reload silently stops otherwise).
export WATCHFILES_FORCE_POLLING="${WATCHFILES_FORCE_POLLING:-true}"
python -m uvicorn app.main:app --app-dir .. --reload --host "${API_HOST:-127.0.0.1}" --port "${API_PORT:-8020}"
