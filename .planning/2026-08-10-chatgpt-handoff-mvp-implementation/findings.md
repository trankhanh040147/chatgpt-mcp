# Findings — ChatGPT Handoff MVP

## Spec Summary (docs/spec.md)

- **Architecture**: Cursor → MCP create_task → SQLite → Playwright dispatches TASK_ID to ChatGPT → ChatGPT get_task/submit_result via MCP → Cursor stop hook polls → followup_message → get_result
- **Stack**: TypeScript, Node.js, MCP SDK, SQLite, Playwright, Python hooks
- **Constraints**: No scraping ChatGPT output, no auto CAPTCHA/approval, Playwright only sends TASK_ID
- **Port**: localhost:8787 for HTTP status API
- **Stop hook**: 480s timeout, 2s poll interval

## Project State

- Repo contains only `docs/spec.md` before implementation
- No existing code or package.json

## Implementation Order (from spec §39)

1. Handoff Core (SQLite + MCP tools)
2. ChatGPT MCP connection (manual test)
3. Browser Dispatcher (Playwright)
4. Cursor Integration (rules + hooks)
5. Auto Resume (stop hook)
6. Failure Handling

## MCP Tool Names

Per spec:
- `handoff.create_task` (Cursor)
- `handoff.get_task` (ChatGPT)
- `handoff.submit_result` (ChatGPT)
- `handoff.get_result` (Cursor)
- `handoff.get_task_status` (both)

Cursor hook matcher: `MCP:handoff_create_task`

## Task Statuses

QUEUED → DISPATCHING → DISPATCHED → PROCESSING → COMPLETED
Failure: FAILED, TIMED_OUT, READY_BUT_CURSOR_IDLE, CANCELLED, WAITING_APPROVAL, RATE_LIMITED

## Worker Statuses

READY, BUSY, NEEDS_APPROVAL, RATE_LIMITED, SESSION_LOST, ERROR
