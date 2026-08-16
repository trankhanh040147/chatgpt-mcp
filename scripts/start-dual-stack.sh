#!/bin/bash
# Dual-worker detached stack: status-api + remote-mcp + browser-workers w1 & w2.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

if [[ ! -f dist/index.js ]]; then
  echo "dist/ missing — run npm run build first" >&2
  exit 1
fi

export HANDOFF_WORKERS_FILE="${HANDOFF_WORKERS_FILE:-$ROOT/data/workers.json}"

pkill -f 'supervise-browser-worker' 2>/dev/null || true
pkill -f 'node dist/index.js browser-worker' 2>/dev/null || true
pkill -f 'node dist/index.js status-api' 2>/dev/null || true
pkill -f 'node dist/index.js remote-mcp' 2>/dev/null || true
sleep 1

start_named() {
  local mode="$1"
  local name="$2"
  shift 2
  local logfile="logs/${name}.log"
  local pidfile="logs/${name}.pid"
  : >"$logfile"
  nohup env "$@" node dist/index.js "$mode" >>"$logfile" 2>&1 &
  echo $! >"$pidfile"
  echo "$name → pid $!"
}

start_named remote-mcp remote-mcp
start_named status-api status-api

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
