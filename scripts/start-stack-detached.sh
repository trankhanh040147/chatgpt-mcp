#!/bin/bash
# Start handoff stack detached (survives Cursor agent shells).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG_DIR="${LOG_DIR:-${CHATGPT_MCP_HOME:-$HOME/.chatgpt-mcp}/logs}"
mkdir -p "$LOG_DIR"

if [[ ! -f dist/index.js ]]; then
  echo "dist/ missing — run npm run build first" >&2
  exit 1
fi

start_one() {
  local mode="$1"
  local pidfile="${LOG_DIR}/${mode}.pid"
  local logfile="${LOG_DIR}/${mode}.log"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$mode already running pid $(cat "$pidfile")"
    return
  fi
  nohup node dist/index.js "$mode" >>"$logfile" 2>&1 &
  echo $! >"$pidfile"
  echo "$mode → pid $!"
}

# Stop prior supervise loop if any
if [[ -f ${LOG_DIR}/browser-worker-supervise.pid ]] && kill -0 "$(cat ${LOG_DIR}/browser-worker-supervise.pid)" 2>/dev/null; then
  echo "browser-worker supervise already running"
else
  pkill -f 'node dist/index.js browser-worker' 2>/dev/null || true
  pkill -f 'supervise-browser-worker.sh' 2>/dev/null || true
  sleep 1
  nohup bash scripts/supervise-browser-worker.sh >/dev/null 2>&1 &
  echo $! > ${LOG_DIR}/browser-worker-supervise.pid
  echo "browser-worker supervise → pid $!"
fi

start_one remote-mcp
if [[ -f ${LOG_DIR}/status-api-supervise.pid ]] && kill -0 "$(cat ${LOG_DIR}/status-api-supervise.pid)" 2>/dev/null; then
  echo "status-api supervise already running"
else
  chmod +x scripts/supervise-status-api.sh
  nohup bash scripts/supervise-status-api.sh >/dev/null 2>&1 &
  echo $! > ${LOG_DIR}/status-api-supervise.pid
  echo "status-api supervise → pid $!"
fi
sleep 2
curl -sf "http://127.0.0.1:8787/health" && echo || echo "status-api not healthy yet"
curl -sf "http://127.0.0.1:8787/worker" && echo || echo "worker state not ready yet"
echo "Done. Check: make status"
