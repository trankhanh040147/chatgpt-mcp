#!/usr/bin/env bash
# Installer smoke matrix (PR1). Safe defaults use a temp CHATGPT_MCP_HOME.
#
#   ./scripts/test-install-smoke.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
chmod +x scripts/install.sh

PASS=0
FAIL=0
assert() {
  if "$@"; then
    echo "PASS: $*"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $*"
    FAIL=$((FAIL + 1))
  fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/gptmcp-install-XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "== case 8: --check-only zero mutation =="
before="$(git status --porcelain)"
./scripts/install.sh --check-only >/dev/null
after="$(git status --porcelain)"
if [[ "$before" == "$after" ]]; then
  echo "PASS: check-only leaves git status unchanged"
  PASS=$((PASS + 1))
else
  echo "FAIL: check-only mutated working tree"
  FAIL=$((FAIL + 1))
fi

echo "== case 7: --skip-build without dist fails =="
# Only meaningful when dist exists; move aside temporarily if present
MOVED=0
if [[ -d dist ]]; then
  mv dist "$TMP/dist.bak"
  MOVED=1
fi
set +e
./scripts/install.sh --skip-build --no-link --home "$TMP/home-skip" >/dev/null 2>"$TMP/skip.err"
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  echo "PASS: --skip-build fails without dist"
  PASS=$((PASS + 1))
else
  echo "FAIL: --skip-build should fail without dist"
  FAIL=$((FAIL + 1))
fi
if [[ $MOVED -eq 1 ]]; then
  mv "$TMP/dist.bak" dist
fi

echo "== case 1: fresh home setup via npm run setup =="
HOME1="$TMP/home1"
CHATGPT_MCP_HOME="$HOME1" npm run setup >/dev/null
assert test -d "$HOME1/data"
assert test -d "$HOME1/logs"
assert test -f "$HOME1/data/workers.json"

echo "== case 2+3: setup idempotent (env + workers unchanged) =="
# Seed a marked .env if missing; then ensure rerun does not rewrite workers
workers_before="$(cksum "$HOME1/data/workers.json" | awk '{print $1}')"
# Inject a marker into workers
node -e '
  const fs=require("fs");
  const p=process.argv[1];
  const j=JSON.parse(fs.readFileSync(p,"utf8"));
  j[0].workerUrl="https://chatgpt.com/c/REAL_CANARY_URL";
  fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
' "$HOME1/data/workers.json"
workers_marked="$(cksum "$HOME1/data/workers.json" | awk '{print $1}')"
CHATGPT_MCP_HOME="$HOME1" npm run setup >/dev/null
workers_after="$(cksum "$HOME1/data/workers.json" | awk '{print $1}')"
assert test "$workers_marked" = "$workers_after"

echo "== case 5: --home with spaces =="
HOME_SP="$TMP/home with spaces"
mkdir -p "$HOME_SP"
CHATGPT_MCP_HOME="$HOME_SP" npm run setup >/dev/null
assert test -f "$HOME_SP/data/workers.json"

echo "== case: install.sh --yes --no-link with custom home =="
# Requires network for npm if clean — use existing node_modules
HOME2="$TMP/home2"
./scripts/install.sh --yes --no-link --home "$HOME2" --skip-build >/dev/null
assert test -f "$HOME2/data/workers.json"
assert test -f dist/gptmcp.js

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
