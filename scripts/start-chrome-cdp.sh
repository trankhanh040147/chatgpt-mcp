#!/usr/bin/env bash
# Thin wrapper — real launcher is start-chrome-cdp.mjs (macOS + Linux).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/start-chrome-cdp.mjs" "$@"
