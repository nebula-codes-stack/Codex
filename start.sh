#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it from https://nodejs.org/ and run this again." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. It normally ships with Node.js." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3000}"
export TERMINAL_CWD="${TERMINAL_CWD:-$ROOT_DIR}"
APP_URL="http://${HOST}:${PORT}"
LOGIN_URL="${APP_URL}/login"

if [ "${NO_OPEN:-0}" != "1" ]; then
  (
    sleep 1.5
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$LOGIN_URL" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then
      open "$LOGIN_URL" >/dev/null 2>&1 || true
    fi
  ) &
fi

echo "Starting Nova Terminal at $LOGIN_URL"
echo "Terminal sessions will open in: $TERMINAL_CWD"
exec npm run dev
