#!/usr/bin/env bash
# chatgpt-mcp onboarding glue — orchestrates npm + setup.ts.
# Application config ownership: scripts/setup.ts (never patch .env here).
#
#   ./scripts/install.sh
#   ./scripts/install.sh --yes
#   ./scripts/install.sh --check-only
#   ./scripts/install.sh --home /tmp/foo --no-link
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

YES=0
CHECK_ONLY=0
NO_LINK=0
SKIP_BUILD=0
HOME_OVERRIDE=""

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [options]

Options:
  --yes           Non-interactive (CI); no prompts
  --check-only    Zero mutation — verify prerequisites only
  --no-link       Skip npm link
  --skip-build    Skip build if dist/index.js + dist/gptmcp.js exist
  --home PATH     Set CHATGPT_MCP_HOME for setup (user state)
  -h, --help      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --no-link) NO_LINK=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --home)
      [[ $# -ge 2 ]] || { echo "Option --home requires a value" >&2; exit 2; }
      HOME_OVERRIDE="$2"
      shift 2
      ;;
    --home=*)
      HOME_OVERRIDE="${1#--home=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "$*"; }
ok() { echo "✓ $*"; }
warn() { echo "⚠ $*" >&2; }
dim() { echo "· $*"; }

node_major_minor() {
  node -e 'const [a,b]=process.versions.node.split("."); process.stdout.write(`${a}.${b}`)'
}

version_ge() {
  # Compare dotted versions: $1 >= $2 ?
  node -e '
    const a=process.argv[1].split(".").map(Number);
    const b=process.argv[2].split(".").map(Number);
    for (let i=0;i<Math.max(a.length,b.length);i++) {
      const x=a[i]||0, y=b[i]||0;
      if (x>y) process.exit(0);
      if (x<y) process.exit(1);
    }
    process.exit(0);
  ' "$1" "$2"
}

phase_preflight() {
  info "Preflight"
  command -v bash >/dev/null || die "bash required"
  command -v node >/dev/null || die "Node.js >=22.14 required"
  command -v npm >/dev/null || die "npm required"

  case "$(uname -s)" in
    Darwin) ok "macOS" ;;
    Linux) ok "Linux (experimental)" ;;
    *) die "Unsupported OS: $(uname -s) — macOS supported, Linux experimental" ;;
  esac

  local ver
  ver="$(node -v | sed 's/^v//')"
  if ! version_ge "$ver" "22.14.0"; then
    die "Node.js >=22.14 required (got v$ver)"
  fi
  ok "Node $ver"

  if [[ ! -f package.json ]]; then
    die "Run from chatgpt-mcp repo root (package.json missing)"
  fi
  local name
  name="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("package.json","utf8")).name||"")')"
  [[ "$name" == "chatgpt-mcp" ]] || die "Unexpected package name: $name"
  ok "repository chatgpt-mcp"

  if [[ ! -f dist/index.js ]] || [[ ! -f dist/gptmcp.js ]]; then
    dim "dist not built yet"
  else
    ok "dist artifacts present"
  fi

  if [[ -n "$HOME_OVERRIDE" ]]; then
    dim "CHATGPT_MCP_HOME override: $HOME_OVERRIDE"
  elif [[ -n "${CHATGPT_MCP_HOME:-}" ]]; then
    dim "CHATGPT_MCP_HOME=${CHATGPT_MCP_HOME}"
  else
    dim "CHATGPT_MCP_HOME=~/.chatgpt-mcp (default)"
  fi

  if [[ -f .env ]]; then
    ok ".env present"
  else
    dim ".env not created yet"
  fi

  local workers_guess="${HOME_OVERRIDE:-${CHATGPT_MCP_HOME:-$HOME/.chatgpt-mcp}}/data/workers.json"
  # Expand ~
  workers_guess="${workers_guess/#\~/$HOME}"
  if [[ -f "$workers_guess" ]]; then
    ok "workers registry present"
  else
    dim "workers registry not created yet"
  fi

  ok "prerequisites satisfied"
}

phase_deps() {
  info ""
  info "Dependencies"
  if [[ -d node_modules ]]; then
    npm install
  else
    npm ci
  fi

  if [[ "$SKIP_BUILD" -eq 1 ]]; then
    if [[ -f dist/index.js && -f dist/gptmcp.js ]]; then
      ok "skip-build (dist present)"
    else
      die "--skip-build requires dist/index.js and dist/gptmcp.js"
    fi
  else
    npm run build
  fi

  [[ -f dist/index.js ]] || die "build failed: dist/index.js missing"
  [[ -f dist/gptmcp.js ]] || die "build failed: dist/gptmcp.js missing"
  ok "build artifacts"
}

phase_setup() {
  info ""
  info "Application bootstrap"
  if [[ -n "$HOME_OVERRIDE" ]]; then
    export CHATGPT_MCP_HOME="$HOME_OVERRIDE"
  fi
  npm run setup
  ok "setup complete"
}

phase_link() {
  info ""
  info "CLI exposure"
  if [[ "$NO_LINK" -eq 1 ]]; then
    dim "skipped npm link (--no-link)"
    return 0
  fi

  local link_out
  set +e
  link_out="$(npm link 2>&1)"
  local link_rc=$?
  set -e

  if [[ $link_rc -eq 0 ]]; then
    if command -v gptmcp >/dev/null 2>&1; then
      ok "gptmcp available on PATH"
    else
      warn "npm link succeeded but gptmcp not on PATH"
      dim "Use: npm run gptmcp -- …   or   node dist/gptmcp.js …"
    fi
  else
    warn "Could not link gptmcp globally"
    # Print short npm error (first meaningful line)
    echo "$link_out" | grep -E 'npm error|EACCES|ERR!|Error:' | head -3 | sed 's/^/  /' >&2 || true
    if [[ -z "$(echo "$link_out" | grep -E 'npm error|EACCES|ERR!|Error:' || true)" ]]; then
      echo "$link_out" | tail -3 | sed 's/^/  /' >&2
    fi
    dim "Install still succeeded. Use: npm run gptmcp -- …"
  fi

  node dist/gptmcp.js help >/dev/null || die "gptmcp executable failed"
  ok "gptmcp executable verified"
}

phase_summary() {
  info ""
  ok "Installation complete"
  info ""
  info "Setup still required"
  info "  1. Paste MCP JSON → ~/.cursor/mcp.json → reload Cursor"
  info "  2. Connect ChatGPT (docs/connect-chatgpt.md)"
  info "  3. gptmcp start"
  info "  4. gptmcp open → Assign URL / New chat for worker w1"
  info ""
  info "Then"
  info "  gptmcp status          # exit 0 = healthy"
  info ""
  info "When broken"
  info "  gptmcp doctor"
  info "  gptmcp recover"
  info ""
  if command -v gptmcp >/dev/null 2>&1; then
    info "CLI: gptmcp"
  else
    info "CLI: npm run gptmcp -- …   or   node dist/gptmcp.js …"
  fi
  info ""
  info "Healthy means: gptmcp status → exit 0"
}

main() {
  phase_preflight
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    info ""
    ok "check-only: zero mutations"
    exit 0
  fi
  phase_deps
  phase_setup
  phase_link
  phase_summary
}

main
