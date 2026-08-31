#!/bin/bash
# Restart status-api if it exits. Detach via start-broker-stack / Makefile (setsid/nohup).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG_DIR="${LOG_DIR:-${CHATGPT_MCP_HOME:-$HOME/.chatgpt-mcp}/logs}"
mkdir -p "$LOG_DIR"
trap '' HUP

if [[ -f "$LOG_DIR/broker-ops.token" ]]; then
  export HANDOFF_BROKER_OPS_TOKEN="${HANDOFF_BROKER_OPS_TOKEN:-$(cat "$LOG_DIR/broker-ops.token")}"
fi
export HANDOFF_BROKER_OPS_PORT="${HANDOFF_BROKER_OPS_PORT:-18788}"

child_pid=""

cleanup() {
  if [[ -n "${child_pid:-}" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

while true; do
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) starting status-api" >> "$LOG_DIR/status-api-supervise.log"
  node dist/index.js status-api >> "$LOG_DIR/status-api.log" 2>&1 &
  child_pid=$!
  echo "$child_pid" > "$LOG_DIR/status-api.pid"
  wait "$child_pid" || true
  code=$?
  child_pid=""
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) status-api exited code=$code — restart in 2s" >> "$LOG_DIR/status-api-supervise.log"
  sleep 2
done
