#!/usr/bin/env bash
# Regenerate assets/chrome-cdp.icns from the locally installed Chrome icon.
# Requires macOS (sips + iconutil). Run after Chrome updates if you want a fresher base icon.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/assets/chrome-cdp.icns"
TMP="$(mktemp -d)"
ICONSET="$TMP/chrome-cdp.iconset"
mkdir -p "$ICONSET" "$(dirname "$OUT")"

CHROME_ICON="/Applications/Google Chrome.app/Contents/Resources/app.icns"
if [[ ! -f "$CHROME_ICON" ]]; then
  CHROME_ICON="$HOME/Applications/Google Chrome.app/Contents/Resources/app.icns"
fi
if [[ ! -f "$CHROME_ICON" ]]; then
  echo "Google Chrome not found; cannot derive CDP icon." >&2
  exit 1
fi

sips -z 16 16 -s format png "$CHROME_ICON" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 -s format png "$CHROME_ICON" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 -s format png "$CHROME_ICON" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 -s format png "$CHROME_ICON" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 -s format png "$CHROME_ICON" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 -s format png "$CHROME_ICON" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 -s format png "$CHROME_ICON" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 -s format png "$CHROME_ICON" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 -s format png "$CHROME_ICON" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 -s format png "$CHROME_ICON" --out "$ICONSET/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$ICONSET" -o "$OUT"
rm -rf "$TMP"
echo "Wrote $OUT"
