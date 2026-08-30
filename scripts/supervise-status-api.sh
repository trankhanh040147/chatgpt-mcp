#!/bin/bash
# Restart status-api if it exits. Detach via start-broker-stack / Makefile (setsid/nohup).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs
trap '' HUP

if [[ -f logs/broker-ops.token ]]; then
  export HANDOFF_BROKER_OPS_TOKEN="${HANDOFF_BROKER_OPS_TOKEN:-$(cat logs/broker-ops.token)}"
fi
export HANDOFF_BROKER_OPS_PORT="${HANDOFF_BROKER_OPS_PORT:-18788}"

while true; do
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) starting status-api" >> logs/status-api-supervise.log
  node dist/index.js status-api >> logs/status-api.log 2>&1 &
  pid=$!
  echo "$pid" > logs/status-api.pid
  wait "$pid" || true
  code=$?
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) status-api exited code=$code — restart in 2s" >> logs/status-api-supervise.log
  sleep 2
done
