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

start_named browser-broker browser-broker \
  HANDOFF_WORKERS_FILE="$HANDOFF_WORKERS_FILE"

sleep 4
curl -sf "http://127.0.0.1:8787/health" && echo || echo "status-api not healthy yet"
curl -sf "http://127.0.0.1:8787/workers" && echo || echo "workers not ready yet"
echo "Done. HANDOFF_WORKERS_FILE=$HANDOFF_WORKERS_FILE (A1-S broker)"
