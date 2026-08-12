#!/usr/bin/env bash
# Launch the CDP Chrome used by `npm run worker`.
#
# Chrome 136+ ignores --remote-debugging-port on the default user-data-dir
# (https://developer.chrome.com/blog/remote-debugging-port). This script
# therefore uses a dedicated directory. Sign into ChatGPT Pro in THIS window.
set -euo pipefail

CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
USER_DATA_DIR="${CHATGPT_CDP_USER_DATA_DIR:-$HOME/chrome-chatgpt-debug}"
PORT="${CHATGPT_CDP_PORT:-9222}"

if [[ ! -x "$CHROME" ]]; then
  echo "Chrome binary not found: $CHROME" >&2
  exit 1
fi

if curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "CDP already listening on :${PORT} — not starting another Chrome."
  curl -s "http://127.0.0.1:${PORT}/json/version"
  echo
  echo "Log into ChatGPT Pro in that window."
  if curl -sf "http://127.0.0.1:8787/health" >/dev/null 2>&1; then
    echo "Worker already running on :8787 — do NOT run npm run worker again."
  else
    echo "Then from chatgpt-mcp: npm run worker"
  fi
  exit 0
fi

mkdir -p "$USER_DATA_DIR"
echo "Starting Chrome CDP on :${PORT}"
echo "  user-data-dir=$USER_DATA_DIR"
echo "Sign into ChatGPT Pro in this window (not your daily Chrome)."
echo "This is NOT your Default profile — Chrome forbids debugging that."

exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  https://chatgpt.com
