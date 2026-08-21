# Handoff timeouts and late submit

How chatgpt-mcp decides a task is `TIMED_OUT`, what the log line actually means, and how a result can still land after that.

Related: [architecture.md](architecture.md) (status machine), [connect-chatgpt.md](connect-chatgpt.md) (MCP write / soft-refuse), env pointer [vault-mac-env.md](vault-mac-env.md).

## Direct summary

`TIMED_OUT` means **ChatGPT did not call `handoff_submit_result` before the worker’s clock expired**. It does **not** by itself mean “MCP write was not approved.”

The worker **does not scrape** a ChatGPT confirmation card. `WAITING_APPROVAL` is an inferred state (~30s after dispatch, when the submit nudge is fenced). The canned timeout error used to always say “Approve MCP write…” — that copy was misleading.

If ChatGPT finishes later, **the same `TASK_ID` can still complete** (`TIMED_OUT` → `COMPLETED`) as long as `result` is still empty. The id is never re-dispatched.

## Two clocks (plus Cursor)

| Clock | Env | Default | Role |
|-------|-----|---------|------|
| Approval window | `DISPATCH_APPROVAL_TIMEOUT_MS` | 120s (this machine: 300s) | If the composer is **idle** and there is still no submit, mark `TIMED_OUT` |
| Hard cap | `DISPATCH_HARD_TIMEOUT_MS` | `max(3× approval, 15m)` | Even if ChatGPT is still generating (Stop button), cut here |
| Cursor wait | `HANDOFF_WAIT_TIMEOUT` | 960s | Stop-hook long-poll. Keep **≥ hard cap**. `GET /tasks/:id/wait` does **not** treat `TIMED_OUT` as immediately terminal |
| Cursor hook kill | `.cursor/hooks.json` `stop.timeout` | 1000s (user + this repo) | Must be **> `HANDOFF_WAIT_TIMEOUT`**, or Cursor kills the wait script first |
| Stop followup loops | `stop.loop_limit` | **1** (required) | `null` re-fires forever on every `followup_message` — spam on FAILED/stuck QUEUED |
| Followup ack | `cursor_followup_at` / `cursor_wait_notified_at` | schema v7 | CAS so each task notifies at most once per phase (wait-timeout vs terminal) |

While Stop is visible, the worker **defers** `TIMED_OUT` until idle or the hard cap. After `TIMED_OUT`, it holds that chat (~20s after idle) so a new `TASK_ID` is not typed over an in-flight submit.

Keep `HANDOFF_LEASE_MS` renewing (heartbeat) — the hard cap can outlast a single lease TTL.

## What to look at when a task times out

1. **`handoff.log`** — `TASK_DISPATCHED`, optional `CHATGPT_PROCESSING` (`handoff_get_task` while still `DISPATCHED`), `Sent submit nudge`, `TASK_TIMED_OUT`. Missing `CHATGPT_PROCESSING` is normal if the nudge already moved the row to `WAITING_APPROVAL`.
2. **Worker tab** (CDP Chrome) — generating vs idle vs MCP “Allow” card vs model text *“Submission was blocked…”*.
3. **Sibling tasks** — if another worker completed in the same window, remote MCP / tunnel is up. The failure is that chat, that prompt, or that clock — not a global outage.

| Worker-tab evidence | Meaning | Action |
|---------------------|---------|--------|
| Stop / “Working…” past the approval window | Still generating (browse, tools, long review) | Wait; late submit is accepted. Hard cap still applies |
| MCP Allow / Always allow on `handoff_submit_result` | Real write confirmation | Click Allow. Retry without this will likely time out again **on a new chat** |
| *“Submission was blocked… approve sending…”* | Model **soft-refuse**, not SQLite rejecting the payload | See [connect-chatgpt.md](connect-chatgpt.md); re-paste spec §17 |
| *submit rejected because status is `TIMED_OUT`* | Late submit **before** the `TIMED_OUT` → `COMPLETED` path (or old binary) | Restart `remote-mcp` + broker on current `dist/`; same id should complete if `result` is null |
| Figma / login wall, no submit | Optional live browse ate the window | Prompt already allows inventory-only review — worker policy tells ChatGPT to submit from the task payload, not wait on the page |

## Example (2026-08-16)

Task `ho_01M04CH3VGAJAP1BAVZPJXNNAW` (`architecture_review`, ~6.5k prompt, asked to open a Figma Make file).

- Dispatched on **w3** (`ChatGPT MCP Bootstrap`) at 04:15:57Z.
- Sibling `code_review` on **w1** completed at 04:18:32Z — MCP write on the pool was fine.
- Nudge fenced 04:16:40Z; actually typed 04:18:02Z (composer busy / shared UI mutex).
- Worker marked `TIMED_OUT` at 04:20:58Z (exactly 301s = `DISPATCH_APPROVAL_TIMEOUT_MS=300000`).
- ChatGPT then called `handoff_submit_result`; server rejected `status TIMED_OUT`. Tab text: review ready, need a new id.

Root cause: **wall clock vs Figma browse**, plus **rejecting late submit**. Not a missing Allow click on w3 (prior tasks on that same chat had completed).

## Operator checklist after this class of failure

- Do **not** assume “retry without approving MCP.” Check the worker tab first.
- Same `TASK_ID`: ChatGPT should call `handoff_submit_result` again if `get_task` shows `lateSubmitAccepted`.
- New handoff: keep optional live URLs as “if reachable; otherwise inventory in the task.”
- After changing timeout/wait/submit code: rebuild and restart **status-api + remote-mcp + browser-broker** (`scripts/start-broker-stack.sh`). Cursor hook `timeout` changes need a new Cursor session.

## Code map

| Piece | File |
|-------|------|
| Defer timeout while generating; hold after `TIMED_OUT` | `src/browser/worker.ts` |
| Stop-button / idle wait (outside UI mutex) | `src/browser/chatgpt.ts` |
| `TIMED_OUT` → `COMPLETED` CAS | `src/tasks/task.repository.ts` `saveResultIfOpen` |
| Submit + timeout messages | `src/tasks/task.service.ts` |
| Allowed transition | `src/tasks/task-state.ts` |
| Wait route ignores `TIMED_OUT` as terminal | `src/http/api.ts` |
| Stop hook keeps waiting | `cursor/wait-handoff.py` |
| Followup dedupe (no FAILED/QUEUED spam) | `cursor_followup_at` / `cursor_wait_notified_at`; `POST /tasks/ack-followup` |
| “Submit from inventory; late submit OK” | `src/mcp/worker-policy.ts` |
