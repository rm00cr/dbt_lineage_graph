#!/usr/bin/env bash
# Starts backend (uv) and frontend (vite) together. Ctrl+C stops both.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# This machine has no system-wide node; a user-local install is used if present.
if ! command -v node >/dev/null 2>&1 && [ -x "$HOME/.local/node/bin/node" ]; then
  export PATH="$HOME/.local/node/bin:$PATH"
fi

command -v uv   >/dev/null 2>&1 || { echo "uv not found — https://docs.astral.sh/uv/"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node not found (needs >= 18)"; exit 1; }

echo "→ backend  http://127.0.0.1:8000  (docs: /docs)"
(cd "$ROOT/back-end" && uv run lineage-api --port 8000 --reload) &
BACKEND_PID=$!

if [ ! -d "$ROOT/front-end/node_modules" ]; then
  echo "→ installing frontend dependencies"
  (cd "$ROOT/front-end" && npm install --no-audit --no-fund)
fi

echo "→ frontend http://localhost:5173"
(cd "$ROOT/front-end" && npm run dev) &
FRONTEND_PID=$!

trap 'kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true' EXIT INT TERM
wait
