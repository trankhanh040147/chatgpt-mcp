#!/bin/bash
# A1-S broker stack: status-api + remote-mcp + one browser-broker (N tabs / 1 CDP).
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

# Shared broker control token — status-api must match browser-broker (see HANDOFF_BROKER_OPS_TOKEN).
export HANDOFF_BROKER_OPS_PORT="${HANDOFF_BROKER_OPS_PORT:-18788}"
if [[ -z "${HANDOFF_BROKER_OPS_TOKEN:-}" ]]; then
  if [[ -f "$LOG_DIR/broker-ops.token" ]]; then
    export HANDOFF_BROKER_OPS_TOKEN="$(cat "$LOG_DIR/broker-ops.token")"
  else
    export HANDOFF_BROKER_OPS_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
    echo "$HANDOFF_BROKER_OPS_TOKEN" > "$LOG_DIR/broker-ops.token"
    chmod 600 "$LOG_DIR/broker-ops.token" 2>/dev/null || true
  fi
fi

if [[ ! -f "$HANDOFF_WORKERS_FILE" ]]; then
  echo "Missing $HANDOFF_WORKERS_FILE" >&2
  echo "Run: npm run setup  (or ./scripts/install.sh) to seed workers.json" >&2
  echo "Template: docs/workers.example.a1s.json" >&2
  exit 1
fi

# Prefer gptmcp stop (owned PID files). Legacy pkill only when not skipped.
if [[ "${GPTMCP_SKIP_PKILL:-}" != "1" ]]; then
  echo "WARN: using legacy pkill -f fallback (prefer: gptmcp stop)" >&2
  pkill -f 'supervise-browser-worker' 2>/dev/null || true
  pkill -f 'supervise-status-api' 2>/dev/null || true
  pkill -f 'node dist/index.js browser-worker' 2>/dev/null || true
  pkill -f 'node dist/index.js browser-broker' 2>/dev/null || true
  pkill -f 'node dist/index.js status-api' 2>/dev/null || true
  pkill -f 'node dist/index.js remote-mcp' 2>/dev/null || true
  sleep 1
fi

preflight_broker_port() {
  local port="${HANDOFF_BROKER_OPS_PORT}"
  local listener
  listener="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ -z "$listener" ]]; then
    return 0
  fi
  local cmd
  cmd="$(ps -p "$listener" -o command= 2>/dev/null || true)"
  if [[ "$cmd" == *"browser-broker"* ]]; then
    kill "$listener" 2>/dev/null || true
    sleep 1
    return 0
  fi
  echo "ERROR: HANDOFF_BROKER_OPS_PORT=$port already in use (pid $listener)" >&2
  echo "  $cmd" >&2
  echo "Stop that process or set HANDOFF_BROKER_OPS_PORT to a free port (status-api + browser-broker must match)." >&2
  exit 1
}

preflight_broker_port

wait_for_cdp() {
  local i
  for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:9222/json/version" >/dev/null 2>&1; then
      sleep 2
      return 0
    fi
    sleep 1
  done
  echo "ERROR: CDP :9222 not ready — run: npm run chrome-cdp  (or make chrome)" >&2
  exit 1
}

start_named() {
  local mode="$1"
  local name="$2"
  shift 2
  local logfile="$LOG_DIR/${name}.log"
  local pidfile="$LOG_DIR/${name}.pid"
  : >"$logfile"
  local pid
  (
    for pair in "$@"; do export "$pair"; done
    node scripts/spawn-detached.mjs "$logfile" node dist/index.js "$mode"
  ) >"$pidfile"
  pid="$(cat "$pidfile")"
  echo "$name → pid $pid"
}

start_named remote-mcp remote-mcp

# status-api is supervised: Cursor/agent shells otherwise SIGTERM the one-shot
# process after the turn (empty log, dashboard API DOWN).
chmod +x "$ROOT/scripts/supervise-status-api.sh"
status_sup_pid="$(node scripts/spawn-detached.mjs "$LOG_DIR/status-api-supervise.out" bash scripts/supervise-status-api.sh)"
echo "$status_sup_pid" > "$LOG_DIR/status-api-supervise.pid"
echo "status-api supervise → pid $status_sup_pid"

wait_for_cdp

start_named browser-broker browser-broker \
  HANDOFF_WORKERS_FILE="$HANDOFF_WORKERS_FILE"

sleep 2
curl -sf "http://127.0.0.1:8787/health" && echo || echo "status-api not healthy yet"
if grep -q EADDRINUSE "$LOG_DIR/browser-broker.log" 2>/dev/null; then
  echo "browser-broker failed to bind :${HANDOFF_BROKER_OPS_PORT} — see $LOG_DIR/browser-broker.log" >&2
fi
broker_ok=0
for _ in $(seq 1 15); do
  if curl -sf "http://127.0.0.1:8787/broker/status" >/dev/null 2>&1; then
    broker_ok=1
    break
  fi
  sleep 1
done
if [[ "$broker_ok" -eq 1 ]]; then
  curl -sf "http://127.0.0.1:8787/broker/status" && echo
  bindings="$(curl -sf "http://127.0.0.1:8787/broker/status" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).bindings||[]).length))}catch{process.stdout.write("0")}})' 2>/dev/null || echo 0)"
  if [[ "${bindings:-0}" -eq 0 ]]; then
    echo "WARN: broker up but bindings=0 — CDP may have raced restart. Retry: make restart  or dashboard Assign URL…" >&2
  fi
else
  echo "broker ops not reachable (:${HANDOFF_BROKER_OPS_PORT}) — check $LOG_DIR/browser-broker.log and port conflict (lsof -i :${HANDOFF_BROKER_OPS_PORT})"
fi
curl -sf "http://127.0.0.1:8787/workers" | head -c 300 && echo "…" || echo "workers not ready yet"
echo "Done. HANDOFF_WORKERS_FILE=$HANDOFF_WORKERS_FILE (A1-S broker)"
echo "Broker token: $LOG_DIR/broker-ops.token (status-api reads this automatically)"
