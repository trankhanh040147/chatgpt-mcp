#!/bin/bash
# Dual-worker detached stack: status-api + remote-mcp + browser-workers w1 & w2.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG_DIR="${LOG_DIR:-${CHATGPT_MCP_HOME:-$HOME/.chatgpt-mcp}/logs}"
mkdir -p "$LOG_DIR"

if [[ ! -f dist/index.js ]]; then
  echo "dist/ missing — run npm run build first" >&2
  exit 1
fi

export HANDOFF_WORKERS_FILE="${HANDOFF_WORKERS_FILE:-${CHATGPT_MCP_HOME:-$HOME/.chatgpt-mcp}/data/workers.json}"

pkill -f 'supervise-browser-worker' 2>/dev/null || true
pkill -f 'supervise-status-api' 2>/dev/null || true
pkill -f 'node dist/index.js browser-worker' 2>/dev/null || true
pkill -f 'node dist/index.js status-api' 2>/dev/null || true
pkill -f 'node dist/index.js remote-mcp' 2>/dev/null || true
sleep 1

start_named() {
  local mode="$1"
  local name="$2"
  shift 2
  local logfile="$LOG_DIR/${name}.log"
  local pidfile="$LOG_DIR/${name}.pid"
  : >"$logfile"
  (
    for pair in "$@"; do export "$pair"; done
    node scripts/spawn-detached.mjs "$logfile" node dist/index.js "$mode"
  ) >"$pidfile"
  echo "$name → pid $(cat "$pidfile")"
}

start_named remote-mcp remote-mcp

chmod +x "$ROOT/scripts/supervise-status-api.sh"
status_sup_pid="$(node scripts/spawn-detached.mjs "$LOG_DIR/status-api-supervise.out" bash scripts/supervise-status-api.sh)"
echo "$status_sup_pid" > "$LOG_DIR/status-api-supervise.pid"
echo "status-api supervise → pid $status_sup_pid"

node -e '
const fs=require("fs");
const w=JSON.parse(fs.readFileSync(process.env.HANDOFF_WORKERS_FILE,"utf8"));
for (const x of w) {
  console.log([x.id, x.workerUrl, x.cdpEndpoint].join("\t"));
}
' | while IFS="$(printf '\t')" read -r id url cdp; do
  start_named browser-worker "browser-worker-${id}" \
    HANDOFF_WORKER_ID="$id" \
    CHATGPT_WORKER_URL="$url" \
    CHATGPT_CDP_ENDPOINT="$cdp" \
    HANDOFF_WORKERS_FILE="$HANDOFF_WORKERS_FILE"
done

sleep 4
curl -sf "http://127.0.0.1:8787/health" && echo || echo "status-api not healthy yet"
curl -sf "http://127.0.0.1:8787/workers" && echo || echo "workers not ready yet"
echo "Done. HANDOFF_WORKERS_FILE=$HANDOFF_WORKERS_FILE"
