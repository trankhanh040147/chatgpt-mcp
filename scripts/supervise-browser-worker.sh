#!/bin/bash
# Restart browser-worker if it exits. Run via nohup from start-stack-detached.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

while true; do
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) starting browser-worker" >> logs/browser-worker-supervise.log
  node dist/index.js browser-worker >> logs/browser-worker.log 2>&1 &
  pid=$!
  echo "$pid" > logs/browser-worker.pid
  wait "$pid" || true
  code=$?
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) browser-worker exited code=$code — restart in 3s" >> logs/browser-worker-supervise.log
  sleep 3
done
