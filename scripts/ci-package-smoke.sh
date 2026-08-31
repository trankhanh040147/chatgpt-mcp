#!/usr/bin/env bash
# Install the packed tarball in a temp dir and smoke-test public bins + runtime assets.
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

PKG="$SMOKE_DIR/node_modules/chatgpt-mcp"
GPTMCP="$SMOKE_DIR/node_modules/.bin/gptmcp"
LEGACY="$SMOKE_DIR/node_modules/.bin/chatgpt-mcp"

for path in \
  "$GPTMCP" \
  "$LEGACY" \
  "$PKG/scripts/start-broker-stack.sh" \
  "$PKG/scripts/supervise-status-api.sh" \
  "$PKG/scripts/start-chrome-cdp.mjs" \
  "$PKG/scripts/spawn-detached.mjs" \
  "$PKG/scripts/lib/macos-cdp-app.mjs"; do
  if [ ! -e "$path" ]; then
    echo "Package smoke missing: $path" >&2
    exit 1
  fi
done

"$GPTMCP" help >/dev/null
"$GPTMCP" completion fish | grep -q 'complete -c gptmcp'

SETUP_HOME="$SMOKE_DIR/home with spaces"
"$GPTMCP" setup --home "$SETUP_HOME" --json > setup.json
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync("setup.json","utf8"));
if (!fs.existsSync(j.workersPath)) process.exit(1);
if (j.envPath !== undefined) process.exit(2);
' || { echo "gptmcp setup smoke failed" >&2; exit 1; }

SMOKE_OUT="$("$LEGACY" __ci_smoke_invalid__ 2>&1 || true)"
if ! echo "$SMOKE_OUT" | grep -q "Unknown mode"; then
  echo "Legacy CLI smoke failed: expected Unknown mode message" >&2
  echo "$SMOKE_OUT" >&2
  exit 1
fi

echo "package smoke OK: $(basename "$TARBALL")"
