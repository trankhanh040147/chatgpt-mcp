# Architecture — chatgpt-mcp

Level: Newcomer. Facts from this repo’s code and config; inferences labeled.

## Direct summary

This system lets **Cursor** ask **ChatGPT** for an independent pass (research, review, second opinion) without scraping the ChatGPT UI for the answer.

- Cursor creates a **task** via MCP.
- A local **browser worker** only types a short `TASK_ID` into a dedicated ChatGPT chat.
- ChatGPT reads the full prompt and writes the answer back **through MCP tools**.
- Cursor polls (or a stop hook **long-polls** `GET /tasks/:id/wait`) and then continues with `handoff_get_result`.

**MCP** here means *Model Context Protocol*: a standard way for an AI client to call **tools** on a server (like a plugin API), not a ChatGPT “GPT store plugin” from the old Plugins marketplace.

## How MCP works (general)

```text
AI client (Cursor or ChatGPT)
        │  tool call (JSON)
        ▼
   MCP server (this repo)
        │  read/write
        ▼
   Shared store (SQLite)
```

| Term | Meaning |
|------|---------|
| **MCP server** | Process that exposes tools (`handoff_create_task`, …) |
| **MCP client** | Cursor agent or ChatGPT (with Developer Mode) that *calls* those tools |
| **Transport** | How client talks to server: **stdio** (local process) or **HTTP** (URL + tunnel) |
| **Tool** | Named function with a schema; the model chooses when to call it |

Same tools, two doors:

| Door | Who uses it | How it runs |
|------|-------------|-------------|
| Stdio MCP | Cursor | Cursor spawns `node dist/index.js mcp` (server id `chatgpt-mcp`) |
| Remote MCP | ChatGPT | `npm run remote-mcp` on `:8790/mcp`, often via ngrok |

Both doors must use the **same database file** (`HANDOFF_DB_PATH`), or Cursor and ChatGPT see different tasks (“Task not found”).

## How *this* handoff system works

```text
Cursor agent
  │ handoff_create_task
  ▼
SQLite (handoff_tasks)
  │ worker claims QUEUED → DISPATCHING
  ▼
Chrome (CDP) — types only: TASK_ID=ho_…
  ▼
ChatGPT worker chat
  │ handoff_get_task  → full prompt/context
  │ (reasons)
  │ handoff_submit_result
  ▼
SQLite COMPLETED
  │
  ▼
Cursor handoff_get_result → continue work
```

### Roles

| Piece | Job |
|-------|-----|
| **Cursor MCP (stdio)** | Create/poll/fetch tasks for the coding agent |
| **Remote MCP (HTTP)** | Lets ChatGPT call `get_task` / `submit_result` from the cloud |
| **Tunnel (e.g. Secure MCP Tunnel / ngrok)** | Gives ChatGPT a public HTTPS URL to localhost `:8790` |
| **SQLite** | Single source of truth for task status + result |
| **Browser worker** | Attaches to Chrome via CDP; opens worker URL; types `TASK_ID` only |
| **Stop hook** (Cursor, this repo) | Optional UX: long-poll until done and inject follow-up. Not required for correctness — `taskId` + status/result tools suffice. |
| **Session id** | Optional `clientSessionId` (Cursor injects `cursorConversationId` alias). If omitted → stored as `unscoped`; auto-resume will not attach. |

### Tools

| Tool | Caller | Purpose |
|------|--------|---------|
| `handoff_create_task` | Coding agent | Create task → `QUEUED` (optional `clientSessionId`) |
| `handoff_get_task_status` | Both | Poll status without full result |
| `handoff_get_result` | Cursor | Read completed answer |
| `handoff_get_task` | ChatGPT | Load full prompt + context + file manifest |
| `handoff_read_file` | ChatGPT | Read one task-scoped evidence file (lazy; `fileId` only) |
| `handoff_submit_result` | ChatGPT | Write answer → `COMPLETED` |

### Task status (simplified)

Worker claims with a **lease** (`lease_owner` + `lease_token` + TTL). Before typing `TASK_ID`, the worker commits a **dispatch fence** (`dispatch_started_at`, status → `DISPATCHED`). Pre-fence lease expiry **requeues**; post-fence expiry → **TIMED_OUT** (never re-dispatch the same id). A later `handoff_submit_result` on that id is still accepted (`TIMED_OUT` → `COMPLETED`) if no result exists.

The worker defers `TIMED_OUT` while ChatGPT is still generating (stop button visible), up to `DISPATCH_HARD_TIMEOUT_MS` (default 15m). Cursor’s wait hook does **not** treat `TIMED_OUT` as immediately terminal, so a late submit can still resume the agent.

**0.2.0 multi-worker:** N `browser-worker` processes (one Chrome profile/CDP/chat each) + one `status-api` on `:8787` (HTTP wait/status + lease reaper + **0.4.0** ops dashboard at `/dashboard/`). Single-worker default still runs `worker`/`all` = status-api + one browser in-process. **Cost:** N CDP Chromes burn RAM and desktop space — accepted for 0.2.0; **0.3.0** shipped CDP optimize + assisted create-worker.

```text
QUEUED → DISPATCHING → [fence] DISPATCHED → PROCESSING → COMPLETED
              ↘ requeue (pre-fence)     ↘ TIMED_OUT / FAILED
```

Worker only claims work when its own state is **READY**. If stuck at `QUEUED`, the HTTP API may still be up while the dispatcher is not READY (e.g. `STARTING`).

**0.5.0 chat budget:** each successful `TASK_ID` send increments `tasks_on_chat` (once per task, including later FAILED/TIMED_OUT). At `HANDOFF_MAX_TASKS_PER_CHAT` (default 20) the worker cannot claim until idle `rotate-worker` commits a new Chat+Cursor URL. Operator then approves MCP writes if needed and restarts the broker. Details: [rotation.md](rotation.md).

## Usage estimates (ops dashboard)

On successful `handoff_submit_result`, chatgpt-mcp snapshots **estimated** tokens for the stored prompt + result (`js-tiktoken` / `o200k_base`).

**Primary metric:** estimated visible-text tokens (not ChatGPT billing).

**Optional secondary:** a **reference API cost** comparison against a Cursor/API list-price scenario (`config/model-prices.json`). This is **off by default** (`HANDOFF_REFERENCE_PRICING=off`). When enabled, the UI labels it as a **comparison scenario** (e.g. “Cursor alternative · Claude Sonnet 5”) — **never** as the ChatGPT runtime model. It is not cash saved and not a ChatGPT invoice.

Enable: `HANDOFF_REFERENCE_PRICING=on` and optionally `HANDOFF_REFERENCE_SCENARIO=claude-sonnet-5`. Backfill: `npm run usage:backfill`.

## Chrome / session model (important)

**Fact:** From Chrome 136, `--remote-debugging-port` is **ignored** on the Default profile directory. Google documents this as a security change.

So the worker does **not** drive your daily Chrome. It attaches to a **dedicated** profile (e.g. `$HOME/chrome-chatgpt-debug`) started with CDP on `:9222`. ChatGPT Pro must be signed in **in that window**.

```text
Daily Chrome (Default)     ← no CDP — Pro cookies stay here
        ≠
CDP Chrome (debug dir)     ← worker attaches here — login Pro again once
```

## Evidence (where this is implemented)

| Concern | Location |
|---------|----------|
| Stdio MCP | `src/mcp/server.ts` |
| Remote HTTP MCP | `src/mcp/remote-server.ts` (`POST /mcp`) |
| Tool definitions | `src/mcp/tools/index.ts` |
| Worker loop | `src/browser/worker.ts` |
| CDP attach | `src/browser/chatgpt.ts` |
| Config / modes | `src/index.ts` (`mcp` \| `status-api` \| `worker` \| `browser-worker` \| `remote-mcp`) |
| Leases / fencing | `src/tasks/task.repository.ts` |
| Topology validation | `src/config/workers-topology.ts` |
| Env inventory | Obsidian `vault-mac-1/configs/chatgpt-mcp-env.md` |
| Ops dashboard | `src/dashboard/public/` served at `/dashboard/` by status-api (`docs/dashboard.md`) |
| Chat rotation | `src/ops/rotate-worker.ts`, `src/workers/chat-budget.ts` (`docs/rotation.md`) |
| Full product spec | `docs/spec.md` |

## Caveats

- **Fact:** Remote MCP binds to `127.0.0.1:8790` and expects path `/mcp`.
- **Fact:** Code comment notes ChatGPT custom connectors may only support OAuth / No Auth (no static Bearer field in UI) — tunnel + auth mode may need adjustment.
- **Inference:** Free ngrok URLs change when the tunnel restarts; ChatGPT’s connector URL must be updated.
- **Unknown without checking live ChatGPT settings:** Whether the current account’s Developer Mode allows MCP **write** tools.

## Minimal mental example

1. In Cursor: “handoff — summarize today’s VN news with web search.”
2. Agent calls `handoff_create_task` → `ho_01ABC…` / `QUEUED`.
3. Worker types `TASK_ID=ho_01ABC…` into the worker chat.
4. ChatGPT calls `handoff_get_task`, researches, calls `handoff_submit_result`.
5. Cursor calls `handoff_get_result` and uses the text.

## Next actions (ops)

| Priority | Step | Expected |
|----------|------|----------|
| 1 | CDP Chrome + Pro login in debug profile | Session for dispatch |
| 2 | One `npm run worker` (`:8787` health OK) | Dispatcher READY |
| 3 | `npm run remote-mcp` + tunnel; connector URL `…/mcp` | ChatGPT can call tools |
| 4 | Approve write tools in worker chat | `submit_result` succeeds |
