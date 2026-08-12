# chatgpt-mcp

**Status:** macOS developer preview (not production). Unofficial — not affiliated with OpenAI or Cursor.

Bridge Cursor IDE Agent with ChatGPT Web for external reasoning, research, and review — without scraping ChatGPT output.

```
Cursor create_task → SQLite → Browser worker (CDP attach) types TASK_ID →
ChatGPT get_task / submit_result via MCP → Cursor stop hook resumes → get_result
```

See [docs/spec.md](docs/spec.md) for the full specification.
See [docs/architecture.md](docs/architecture.md) for how MCP and this handoff flow work.

## Prerequisites

- macOS + Node.js 22.5+ (uses the built-in `node:sqlite` module)
- Python 3 (for Cursor hooks in this repo)
- **Google Chrome** with CDP on a **dedicated** user-data-dir (see below). Chrome 136+ will **not** honor `--remote-debugging-port` on your daily Default profile.
- ChatGPT account with **Developer Mode** + MCP **write** where your plan/workspace allows it (Plus may be read-only — check current OpenAI docs)

## Quick Start

```bash
npm install
npm run build
npm run setup          # creates ~/.chatgpt-mcp + prints Cursor MCP JSON
# edit .env → set CHATGPT_WORKER_URL

./scripts/start-chrome-cdp.sh   # login ChatGPT in THAT window
npm run remote-mcp              # + HTTPS tunnel for ChatGPT connector
npm run worker
npm run check                   # preflight
```

Paste the JSON from `npm run setup` into `~/.cursor/mcp.json`, then reload Cursor MCP.

## Limitations (read before opening issues)

- macOS-only preview; Windows/Linux not supported yet
- One user, one dedicated Chrome profile, one worker chat, one concurrent handoff
- No login/CAPTCHA/approval automation; UI selectors can break when ChatGPT changes
- Do not send sensitive code over an unauthenticated public tunnel — prefer Secure MCP Tunnel; ngrok is a fallback for non-sensitive evaluation only
- Transport canary (local): 10/10 consecutive PASS observed; full ≥18/20 gate optional for release claims

## Use from other Cursor conversations

- MCP: `~/.cursor/mcp.json` → server `chatgpt-mcp` (paths from `npm run setup`)
- Skill: `~/.cursor/skills/chatgpt-mcp/SKILL.md` (`/chatgpt-mcp`)
- Rule: `~/.cursor/rules/chatgpt-mcp.mdc`

Reload Cursor MCP once after changing `~/.cursor/mcp.json`. Worker must still be running (`npm run worker`).

Say: `handoff sang ChatGPT: <câu hỏi>` or `chạy task ChatGPT: <prompt>`. The agent calls `handoff_create_task`, polls status, then `handoff_get_result`.

## First-Time ChatGPT Setup

1. Run `./scripts/start-chrome-cdp.sh` (dedicated `$HOME/chrome-chatgpt-debug`). Do **not** point `--user-data-dir` at `~/Library/Application Support/Google/Chrome`.
2. Log into ChatGPT manually in **that** window (no automation). Daily Chrome stays untouched and cannot be attached.
3. Enable **Developer Mode** in ChatGPT settings.
4. Connect the remote MCP server (Secure MCP Tunnel or HTTPS tunnel → `npm run remote-mcp` on `:8790/mcp`).
5. Open/create the worker conversation and copy its URL into `CHATGPT_WORKER_URL`.
6. Paste the worker instructions from [docs/spec.md §17](docs/spec.md).
7. Run `npm run worker` — it attaches via CDP and navigates to that URL.
8. Test `handoff_get_task` / `handoff_submit_result`; approve MCP write for the conversation.

The worker **never** launches a dedicated Playwright profile and **never** automates login. If the attached Chrome is logged out, it fails with `SESSION_NOT_READY`.

## MCP Tools

| Tool | Caller | Purpose |
|------|--------|---------|
| `handoff_create_task` | Cursor | Create a handoff task |
| `handoff_get_result` | Cursor | Fetch completed result |
| `handoff_get_task_status` | Both | Poll task status |
| `handoff_get_task` | ChatGPT | Fetch task context |
| `handoff_submit_result` | ChatGPT | Submit reasoning result |

## Processes

| Command | Description |
|---------|-------------|
| `npm run setup` | Create `~/.chatgpt-mcp` + print Cursor MCP JSON |
| `npm run check` | Preflight (Node, build, CDP, worker, remote MCP) |
| `npm run mcp` | MCP stdio server (Cursor spawns this) |
| `npm run worker` | HTTP API (:8787) + CDP dispatcher |
| `npm run http` | HTTP status API only |
| `npm run remote-mcp` | HTTP MCP for ChatGPT (`:8790/mcp`) |
| `npm run e2e:reliability` | Transport canary (`--runs=N`) |
| `make handoff-zip` | Zip source for ChatGPT review |

## Cursor Integration

- **Project rule**: `.cursor/rules/chatgpt-mcp.mdc`
- **User rule / skill** (every workspace): `~/.cursor/rules/chatgpt-mcp.mdc`, `~/.cursor/skills/chatgpt-mcp/`
- **Hooks** (this repo only): `.cursor/hooks.json`
  - `preToolUse`: injects `cursorConversationId`
  - `stop`: polls up to 8 minutes, returns `followup_message` on completion
- Other workspaces have MCP tools but **no stop hook** — the agent must poll `handoff_get_task_status` itself.

## Environment Variables

See [.env.example](.env.example).

Key settings:

- `CHATGPT_MCP_HOME=~/.chatgpt-mcp` — default DB/log root when paths unset
- `CHATGPT_CDP_ENDPOINT=http://127.0.0.1:9222` — attach to existing Chrome
- `CHATGPT_WORKER_URL=https://chatgpt.com/c/...` — direct worker chat URL (required)
- `HANDOFF_HTTP_PORT=8787` — status API for stop hook / `npm run check`
- `HANDOFF_WAIT_TIMEOUT=480` — stop hook timeout (seconds)

## Architecture Notes

- Browser layer **attaches** via CDP to the Chrome listening on `CHATGPT_CDP_ENDPOINT` (dedicated `user-data-dir`). It does **not** use daily Chrome cookies (Chrome 136+ blocks that).
- Playwright sends **only** `TASK_ID=ho_...` into the configured worker URL — no large context via UI.
- ChatGPT reads full context via `handoff_get_task` MCP call.
- Results flow back via `handoff_submit_result` → SQLite → Cursor.
- Concurrency = 1: while a task is `PROCESSING`, the worker stays `BUSY`.
- No CAPTCHA/approval auto-clicking; no login automation; no bundled-Chromium fallback.
- Tasks exceeding 8 minutes may end up as `READY_BUT_CURSOR_IDLE`.

## Logs

Structured JSON logs under `$CHATGPT_MCP_HOME/logs` (or `LOG_DIR`).

## License

[MIT](LICENSE)
