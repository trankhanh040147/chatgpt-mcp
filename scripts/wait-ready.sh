#!/usr/bin/env bash
# Poll GET /worker until status=READY (or timeout).
set -euo pipefail
URL="${HANDOFF_HTTP_URL:-http://127.0.0.1:8787}"
TIMEOUT="${1:-120}"
INTERVAL="${2:-2}"

deadline=$((SECONDS + TIMEOUT))
while (( SECONDS < deadline )); do
  body="$(curl -sf "${URL}/worker" 2>/dev/null || true)"
  if [[ "$body" == *'"status":"READY"'* ]]; then
    echo "READY"
    exit 0
  fi
  if [[ -n "$body" ]]; then
    echo "waiting… $body"
  else
    echo "waiting… worker not reachable at ${URL}"
  fi
  sleep "$INTERVAL"
done

echo "timeout after ${TIMEOUT}s (worker not READY)" >&2
exit 1
