#!/usr/bin/env bash
set -euo pipefail
python -m uvicorn app.main:app --reload --host "${API_HOST:-127.0.0.1}" --port "${API_PORT:-8000}"
