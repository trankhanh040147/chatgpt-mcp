#!/bin/bash
# Restart browser-worker if it exits. Run via nohup from start-stack-detached.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

child_pid=""

cleanup() {
  if [[ -n "${child_pid:-}" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

while true; do
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) starting browser-worker" >> logs/browser-worker-supervise.log
  node dist/index.js browser-worker >> logs/browser-worker.log 2>&1 &
  child_pid=$!
  echo "$child_pid" > logs/browser-worker.pid
  wait "$child_pid" || true
  code=$?
  child_pid=""
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) browser-worker exited code=$code — restart in 3s" >> logs/browser-worker-supervise.log
  sleep 3
done
