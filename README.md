# chatgpt-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥22.5](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)](package.json)
[![macOS supported](https://img.shields.io/badge/macOS-supported-0A7-success)](#support-and-limitations)
[![Linux experimental](https://img.shields.io/badge/Linux-experimental-yellow)](#support-and-limitations)

Delegate selected Cursor tasks to a dedicated ChatGPT Web worker and receive the result through MCP — without copying prompts or scraping the ChatGPT DOM.

> **Developer preview** `0.2.0-preview.0` — not production.  
> **macOS** supported · **Ubuntu desktop** experimental · **Windows** not supported.  
> **Clients:** Cursor E2E · Claude Code / other MCP hosts — experimental (manual poll by `taskId`).  
> Unofficial — not affiliated with OpenAI or Cursor.

**Demo (recording pending):** end-to-end GIF checklist → [`docs/assets/README.md`](docs/assets/README.md). Target path: `docs/assets/handoff-demo.gif`.

## When to use it

- Architecture or security review
- Current web research with live sources
- Independent second opinion on a design or patch
- Hard debugging after the first approach stalls

**Not for:** unattended production automation, sensitive data over public no-auth tunnels, or trivial coding you can finish in Cursor alone.

## Quick Start

### Prerequisites

- Node.js **22.5+** (built-in `node:sqlite`)
- Python 3 (hooks in this repo)
- Google Chrome / Chromium with CDP on a **dedicated** profile (Chrome 136+ will **not** debug Default)
- ChatGPT **Developer Mode** + MCP write (plan/workspace permitting)
- Linux experimental: graphical session (`DISPLAY` / `WAYLAND_DISPLAY`); not WSL/headless

### 1. Install

```bash
npm install
npm run build
npm run setup          # ~/.chatgpt-mcp + prints Cursor MCP JSON
```

Copy the printed JSON into `~/.cursor/mcp.json`, then reload Cursor MCP.

### 2. Configure worker URL

```bash
cp .env.example .env
# set CHATGPT_WORKER_URL=https://chatgpt.com/c/...
```

### 3. Start the stack

```bash
npm run start                   # CDP Chrome + remote-mcp (:8790) + worker (:8787)
# Log into ChatGPT Pro in the CDP window if needed (manual — no login automation)
# Ctrl+C later stops remote-mcp + worker; Chrome stays open

# other terminal:
npm run check                   # expect CDP + worker READY
```

If ports are already taken, use `./scripts/start-chrome-cdp.sh`, `npm run remote-mcp`, and `npm run worker` separately.

### 4. Connect ChatGPT (first time)

Prefer **OpenAI Secure MCP Tunnel**. Full steps (Developer Mode, write approval, worker instructions): [docs/connect-chatgpt.md](docs/connect-chatgpt.md).

### 5. First handoff

In Cursor (with MCP loaded and worker `READY`):

```text
handoff sang ChatGPT: Summarize the architecture of this repo in 5 bullets.
```

Or say `/chatgpt-mcp` / `chạy task ChatGPT: …`. The agent calls `handoff_create_task` and **ends the turn** (no status-poll loop). User-level Cursor hooks (`~/.cursor/hooks/chatgpt-mcp-*.sh`) plus this repo’s stop hook long-poll and resume for `handoff_get_result`.

**Expected:** `npm run check` shows worker `READY`; after the handoff, `handoff_get_result` returns ChatGPT’s answer (not a scraped DOM dump).

Other workspaces: keep the user skill/rule (`~/.cursor/skills/chatgpt-mcp`, `~/.cursor/rules/chatgpt-mcp.mdc`) **and** the user hooks above so every Cursor chat gets inject + stop/resume without polling.

## How it works

```mermaid
flowchart LR
  C["Cursor agent"] -->|create task| Q["Local SQLite queue"]
  Q -->|task ID only| B["CDP worker"]
  B -->|types task ID| W["ChatGPT worker"]
  W -->|MCP get / submit| M["Local MCP server"]
  M --> Q
  Q -->|result| C
```

CDP is used only to enter the opaque task ID; task content and the final result travel through MCP.

**Client support:** Cursor is the supported end-to-end client (stop hook + session injection). The stdio MCP tools are host-neutral (`taskId` authoritative; optional `clientSessionId`). Claude Code and other MCP hosts can connect experimentally and must poll/fetch by `taskId` until a native adapter exists — do not claim “works with all coding agents.”

Deep dive: [docs/architecture.md](docs/architecture.md) · [docs/spec.md](docs/spec.md)

## Support and limitations

| Surface | Status |
|---------|--------|
| macOS + Google Chrome | Supported |
| Ubuntu desktop + Google Chrome stable | Experimental (not Snap/WSL/headless) |
| Windows / WSL / headless | Not supported |

- One user, one dedicated Chrome profile, one worker chat, **one concurrent handoff**
- No login / CAPTCHA / approval automation; ChatGPT UI changes can break selectors
- Do **not** tunnel `:8787` (status/worker). Only expose `/mcp` on `:8790`
- MCP SDK pin: `@modelcontextprotocol/sdk@1.30.0` — compatibility pin, not a “latest-spec SOTA” claim

### Legacy Chrome profile

If you already use `~/chrome-chatgpt-debug`:

```bash
export CHATGPT_CDP_USER_DATA_DIR=~/chrome-chatgpt-debug
```

The launcher also auto-prefers that directory when it exists and `$CHATGPT_MCP_HOME/chrome-profile` does not. Profiles are **not** copied automatically — close Chrome before switching.

## Security and privacy

- Tasks and results live in local SQLite under `$CHATGPT_MCP_HOME` (default `~/.chatgpt-mcp`)
- Dedicated Chrome profile — never your daily Default profile
- Prefer **Secure MCP Tunnel** for private code; public no-auth tunnels are evaluation-only
- Worker types only `TASK_ID=…`; it does **not** scrape ChatGPT answers from the DOM
- You must manually approve MCP write tools in the worker conversation
- Do not hand off secrets, credentials, or regulated data unless you accept the browser + tunnel trust boundary

See [SECURITY.md](SECURITY.md).

## Configuration

See [.env.example](.env.example). Critical variables:

| Variable | Default / notes |
|----------|-----------------|
| `CHATGPT_MCP_HOME` | `~/.chatgpt-mcp` — DB + logs root |
| `CHATGPT_CDP_ENDPOINT` | `http://127.0.0.1:9222` |
| `CHATGPT_WORKER_URL` | Required — worker chat URL |
| `HANDOFF_HTTP_PORT` | `8787` — status API (loopback) |
| `HANDOFF_REMOTE_MCP_PORT` | `8790` — ChatGPT MCP |
| `HANDOFF_WAIT_TIMEOUT` | `480` — stop hook seconds (long-poll) |
| `HANDOFF_WAIT_TICK_MS` | `250` — server wait tick |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| CDP not ready / Chrome ignored debug port | Use `./scripts/start-chrome-cdp.sh` (dedicated profile), not Default |
| `SESSION_NOT_READY` | Log into ChatGPT in the CDP window |
| Worker not `READY` / task stuck `QUEUED` | One `npm run worker`; same absolute `HANDOFF_DB_PATH` for MCP + worker |
| ChatGPT cannot call tools | Secure Tunnel / connector setup; approve write tools — [docs/connect-chatgpt.md](docs/connect-chatgpt.md) |
| Write / approval blocked | Enable Developer Mode + MCP write for your plan/workspace |

Diagnostic: `npm run check`

## Reliability and benchmarks

Maintainer transport canary: **10/10** consecutive PASS (method: `npm run e2e:reliability`). Full ≥18/20 gate optional.

A/B quality suite is **frozen** at [docs/benchmark/](docs/benchmark/README.md) (`bench-v1`, T1–T5). Scores are **pending** — README will not claim uplift until [results.md](docs/benchmark/results.md) is filled. Onboarding timing protocol: [docs/onboarding-timing.md](docs/onboarding-timing.md).

## Documentation

- [Docs index](docs/README.md)
- [Roadmap](docs/roadmap.md) — versions & exit criteria (SSOT)
- [Connect ChatGPT](docs/connect-chatgpt.md) — Secure Tunnel, Developer Mode
- [Architecture](docs/architecture.md)
- [Specification](docs/spec.md)
- [Benchmark suite](docs/benchmark/README.md)
- [Onboarding timing](docs/onboarding-timing.md)
- [Demo capture checklist](docs/assets/README.md)

## MCP tools (reference)

| Tool | Caller | Purpose |
|------|--------|---------|
| `handoff_create_task` | Cursor | Create a handoff task |
| `handoff_get_result` | Cursor | Fetch completed result |
| `handoff_get_task_status` | Both | Poll task status |
| `handoff_get_task` | ChatGPT | Fetch task context |
| `handoff_submit_result` | ChatGPT | Submit reasoning result |

| Command | Role |
|---------|------|
| `npm run setup` / `start` / `check` | Onboarding + stack + preflight |
| `npm run mcp` | Cursor stdio MCP |
| `npm run worker` | HTTP `:8787` + CDP dispatcher |
| `npm run remote-mcp` | ChatGPT HTTP MCP `:8790/mcp` |
| `npm run e2e:reliability` | Transport canary |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues: [github.com/trankhanh040147/chatgpt-mcp/issues](https://github.com/trankhanh040147/chatgpt-mcp/issues).

## License

[MIT](LICENSE)
