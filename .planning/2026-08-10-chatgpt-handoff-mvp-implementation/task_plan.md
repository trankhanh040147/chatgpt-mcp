# Task Plan: ChatGPT Handoff MVP Implementation

## Goal
Implement the full Cursor ↔ ChatGPT Handoff MVP per `docs/spec.md` — MCP server, SQLite storage, Playwright dispatcher, and Cursor hooks/rules.

## Next Step
Manual live verification: first-time ChatGPT setup (login, Developer Mode, connect MCP, open "Cursor Handoff Worker" conversation) per spec §23, then run the 20-consecutive-handoff reliability test from spec §37.

## Current Phase
Phase 5 (automated verification complete; manual/live verification remains)

## Phases

### Phase 1: Handoff Core (MCP + SQLite)
- [x] package.json, tsconfig, project structure
- [x] SQLite schema + repository + task service
- [x] MCP server with create_task, get_task, submit_result, get_result, get_task_status
- [x] Secret sanitizer + idempotency
- **Status:** complete

### Phase 2: Browser Dispatcher (Playwright)
- [x] Playwright worker loop with persistent profile
- [x] Centralized selectors
- [x] Worker state machine + locking
- **Status:** complete (code written; not yet exercised against a live ChatGPT session — needs manual first-time setup)

### Phase 3: Cursor Integration
- [x] `.cursor/rules/chatgpt-handoff.mdc`
- [x] `.cursor/hooks.json`
- [x] `cursor/inject-session.py` + `cursor/wait-handoff.py`
- **Status:** complete

### Phase 4: Failure Handling & Logging
- [x] Timeout, retry, rate-limit states
- [x] READY_BUT_CURSOR_IDLE transition
- [x] Structured logging
- **Status:** complete

### Phase 5: Verification
- [x] TypeScript build passes (`npm run typecheck`, `npm run build`)
- [x] Manual MCP tool smoke test (real stdio client: listTools, create_task, get_task_status)
- [x] End-to-end task-service smoke test (create → sanitize → dispatch → get_task→PROCESSING → submit_result → idempotent resubmit → get_result, secrets redacted throughout)
- [x] HTTP status API smoke test (`/health`, `/conversations/pending`)
- [x] `wait-handoff.py` smoke test against live HTTP API — confirmed correct `followup_message` on completion
- [x] README with setup instructions
- [ ] Live Playwright ↔ ChatGPT dispatch (needs manual login/Developer Mode/MCP connect — cannot be automated per spec constraints)
- [ ] 20-consecutive-handoff reliability run (spec §37) — requires the live setup above
- **Status:** in_progress (everything automatable is done; remaining items require the user's one-time manual ChatGPT setup)

## Key Questions
1. MCP transport for Cursor? → stdio (standard for Cursor MCP) — confirmed working via real stdio client test.
2. Task ID format? → `ho_` prefix + ULID via `ulid` package.
3. HTTP server for stop hook polling? → localhost:8787, confirmed working.

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| stdio MCP for Cursor | Standard Cursor MCP integration; verified with real `@modelcontextprotocol/sdk` client over stdio |
| Node built-in `node:sqlite` (not better-sqlite3) | Avoids a native-module dependency; requires Node ≥22.5 (project already targets this via `engines`) |
| ulid for task IDs | Spec examples use ho_ prefix + sortable IDs |
| HTTP status endpoint on :8787 | Stop hook Python script needs to poll without an MCP client |
| Playwright headed mode | Spec requires headed for login/approval |
| `from __future__ import annotations` in wait-handoff.py | PEP 604 `X \| None` hints crash on Python <3.10; this defers annotation evaluation for compatibility |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `tsc --noEmit`: `Cannot find module '../tasks/task.service.js'` in `src/mcp/tools/index.ts` | 1 | Wrong relative path (only went up one dir from `src/mcp/tools/` instead of two). Fixed to `../../tasks/task.service.js`. |
| `tsc`: `sanitizeContext` / repository `.run()`/`.all()` type errors (`HandoffTaskContext` not assignable to `Record<string, unknown>`; `unknown[]` not assignable to `SQLInputValue[]`; `Record<string, SQLOutputValue>[]` not assignable to `TaskRow[]`) | 1 | Made `sanitizeContext` generic, added local `SqlParam` type for bound values, and `as unknown as TaskRow[]` for the row-array cast. |
| `dist/index.js` MCP/HTTP start crashed: `ENOENT dist/db/schema.sql` | 1 | `tsc` only compiles `.ts`; build script didn't copy `schema.sql` into `dist/`. Added `mkdir -p dist/db && cp src/db/schema.sql dist/db/schema.sql` to the `build` npm script. |
| `wait-handoff.py` crashed: `TypeError: unsupported operand type(s) for \|: 'type' and 'NoneType'` (Python 3.9.6) | 1 | PEP 604 union syntax needs Python ≥3.10. Added `from __future__ import annotations` to defer annotation evaluation. |
| README said "Node.js 20+" | 1 | Code uses `node:sqlite`, which needs Node ≥22.5. Updated README prerequisite. |
