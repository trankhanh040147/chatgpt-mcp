#!/usr/bin/env bash
# Install the packed tarball in a temp dir and smoke-test the CLI bin.
# Usage: npm pack && bash scripts/ci-package-smoke.sh [path/to/chatgpt-mcp-x.y.z.tgz]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARBALL="${1:-}"
if [ -z "$TARBALL" ]; then
  TARBALL="$(ls -1 chatgpt-mcp-*.tgz 2>/dev/null | head -1 || true)"
fi
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  echo "No tarball found. Run npm pack first or pass a path." >&2
  exit 1
fi

SMOKE_DIR="$(mktemp -d)"
trap 'rm -rf "$SMOKE_DIR"' EXIT

cd "$SMOKE_DIR"
npm init -y >/dev/null 2>&1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install "$ROOT/$TARBALL" >/dev/null 2>&1

du -sh node_modules

BIN="./node_modules/.bin/chatgpt-mcp"
if [ ! -x "$BIN" ]; then
  echo "CLI bin missing from installed tarball: $BIN" >&2
  exit 1
fi

SMOKE_OUT="$("$BIN" __ci_smoke_invalid__ 2>&1 || true)"
if ! echo "$SMOKE_OUT" | grep -q "Unknown mode"; then
  echo "CLI smoke failed: expected Unknown mode message" >&2
  echo "$SMOKE_OUT" >&2
  exit 1
fi

echo "package smoke OK: $(basename "$TARBALL")"
