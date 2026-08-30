#!/bin/bash
# A1-S broker stack: status-api + remote-mcp + one browser-broker (N tabs / 1 CDP).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

if [[ ! -f dist/index.js ]]; then
  echo "dist/ missing — run npm run build first" >&2
  exit 1
fi

export HANDOFF_WORKERS_FILE="${HANDOFF_WORKERS_FILE:-$ROOT/data/workers.a1s.json}"

# Shared broker control token — status-api must match browser-broker (see HANDOFF_BROKER_OPS_TOKEN).
export HANDOFF_BROKER_OPS_PORT="${HANDOFF_BROKER_OPS_PORT:-18788}"
if [[ -z "${HANDOFF_BROKER_OPS_TOKEN:-}" ]]; then
  if [[ -f logs/broker-ops.token ]]; then
    export HANDOFF_BROKER_OPS_TOKEN="$(cat logs/broker-ops.token)"
  else
    export HANDOFF_BROKER_OPS_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
    echo "$HANDOFF_BROKER_OPS_TOKEN" > logs/broker-ops.token
  fi
fi

if [[ ! -f "$HANDOFF_WORKERS_FILE" ]]; then
  echo "Missing $HANDOFF_WORKERS_FILE" >&2
  echo "Copy docs/workers.example.a1s.json → data/workers.a1s.json and set two /c/… URLs on the SAME cdpEndpoint." >&2
  exit 1
fi

pkill -f 'supervise-browser-worker' 2>/dev/null || true
pkill -f 'supervise-status-api' 2>/dev/null || true
pkill -f 'node dist/index.js browser-worker' 2>/dev/null || true
pkill -f 'node dist/index.js browser-broker' 2>/dev/null || true
pkill -f 'node dist/index.js status-api' 2>/dev/null || true
pkill -f 'node dist/index.js remote-mcp' 2>/dev/null || true
sleep 1

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
  local logfile="logs/${name}.log"
  local pidfile="logs/${name}.pid"
  : >"$logfile"
  # Detach via new session so Cursor/agent shells do not reap children on exit.
  local pid
  pid="$(
    MODE="$mode" LOGFILE="$logfile" EXTRA_ENV="$(printf '%s\0' "$@")" python3 - <<'PY'
import os, subprocess
mode = os.environ["MODE"]
logfile = os.environ["LOGFILE"]
extra = os.environ.get("EXTRA_ENV", "")
env = os.environ.copy()
for chunk in extra.split("\0"):
    if not chunk or "=" not in chunk:
        continue
    k, v = chunk.split("=", 1)
    env[k] = v
for drop in ("MODE", "LOGFILE", "EXTRA_ENV"):
    env.pop(drop, None)
log = open(logfile, "ab", buffering=0)
p = subprocess.Popen(
    ["node", "dist/index.js", mode],
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    env=env,
    cwd=os.getcwd(),
)
print(p.pid)
PY
  )"
  echo "$pid" >"$pidfile"
  echo "$name → pid $pid"
}

start_named remote-mcp remote-mcp

# status-api is supervised: Cursor/agent shells otherwise SIGTERM the one-shot
# process after the turn (empty log, dashboard API DOWN).
chmod +x "$ROOT/scripts/supervise-status-api.sh"
status_sup_pid="$(
  python3 - <<'PY'
import os, subprocess
log = open("logs/status-api-supervise.out", "ab", buffering=0)
p = subprocess.Popen(
    ["bash", "scripts/supervise-status-api.sh"],
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    env=os.environ.copy(),
    cwd=os.getcwd(),
)
print(p.pid)
PY
)"
echo "$status_sup_pid" > logs/status-api-supervise.pid
echo "status-api supervise → pid $status_sup_pid"

wait_for_cdp

start_named browser-broker browser-broker \
  HANDOFF_WORKERS_FILE="$HANDOFF_WORKERS_FILE"

sleep 2
curl -sf "http://127.0.0.1:8787/health" && echo || echo "status-api not healthy yet"
if grep -q EADDRINUSE logs/browser-broker.log 2>/dev/null; then
  echo "browser-broker failed to bind :${HANDOFF_BROKER_OPS_PORT} — see logs/browser-broker.log" >&2
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
  bindings="$(curl -sf "http://127.0.0.1:8787/broker/status" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("bindings",[])))' 2>/dev/null || echo 0)"
  if [[ "${bindings:-0}" -eq 0 ]]; then
    echo "WARN: broker up but bindings=0 — CDP may have raced restart. Retry: make restart  or dashboard Assign URL…" >&2
  fi
else
  echo "broker ops not reachable (:${HANDOFF_BROKER_OPS_PORT}) — check logs/browser-broker.log and port conflict (lsof -i :${HANDOFF_BROKER_OPS_PORT})"
fi
curl -sf "http://127.0.0.1:8787/workers" | head -c 300 && echo "…" || echo "workers not ready yet"
echo "Done. HANDOFF_WORKERS_FILE=$HANDOFF_WORKERS_FILE (A1-S broker)"
echo "Broker token: logs/broker-ops.token (status-api reads this automatically)"
