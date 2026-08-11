# Cursor ↔ ChatGPT Handoff MVP

Bridge Cursor IDE Agent with ChatGPT Web for external reasoning, research, and review — without scraping ChatGPT output.

```
Cursor create_task → SQLite → Playwright dispatches TASK_ID →
ChatGPT get_task / submit_result via MCP → Cursor stop hook resumes → get_result
```

See [docs/spec.md](docs/spec.md) for the full specification.

## Prerequisites

- Node.js 22.5+ (uses the built-in `node:sqlite` module)
- Python 3 (for Cursor hooks)
- ChatGPT subscription with **Developer Mode**
- Playwright Chromium (`npx playwright install chromium`)

## Quick Start

```bash
# Install dependencies
npm install
npx playwright install chromium

# Build
npm run build

# Copy environment config
cp .env.example .env

# Terminal 1 — HTTP status API + browser worker
npm run worker

# Cursor MCP server is configured in .cursor/mcp.json (stdio, spawned by Cursor)
```

## First-Time ChatGPT Setup

1. Run `npm run worker` — a headed browser opens.
2. Log in to ChatGPT manually (once).
3. Enable **Developer Mode** in ChatGPT settings.
4. Connect the Handoff MCP server to ChatGPT (Secure MCP Tunnel or remote MCP).
5. Create/open a conversation named **Cursor Handoff Worker**.
6. Paste the worker instructions from [docs/spec.md §17](docs/spec.md).
7. Test `handoff_get_task` and `handoff_submit_result` manually.
8. Approve MCP write tool when prompted; remember approval for this conversation.

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
| `npm run mcp` | MCP stdio server (Cursor spawns this) |
| `npm run worker` | HTTP API (:8787) + Playwright dispatcher |
| `npm run http` | HTTP status API only |
| `npm run all` | Worker + HTTP (same as `worker`) |

## Cursor Integration

- **Rule**: `.cursor/rules/chatgpt-handoff.mdc`
- **Hooks**: `.cursor/hooks.json`
  - `preToolUse`: injects `cursorConversationId`
  - `stop`: polls up to 8 minutes, returns `followup_message` on completion

## Environment Variables

See [.env.example](.env.example).

Key settings:

- `HANDOFF_HTTP_PORT=8787` — status API for stop hook
- `HANDOFF_WAIT_TIMEOUT=480` — stop hook timeout (seconds)
- `CHATGPT_WORKER_CONVERSATION=Cursor Handoff Worker`

## Architecture Notes

- Playwright sends **only** `TASK_ID=ho_...` to ChatGPT — no large context via UI.
- ChatGPT reads full context via `handoff_get_task` MCP call.
- Results flow back via `handoff_submit_result` → SQLite → Cursor.
- No CAPTCHA/approval auto-clicking in V1.
- Tasks exceeding 8 minutes may end up as `READY_BUT_CURSOR_IDLE`.

## Logs

Structured JSON logs: `logs/handoff.log`

## License

Private / internal use.
