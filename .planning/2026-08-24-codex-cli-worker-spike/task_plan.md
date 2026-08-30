# Task plan — Codex CLI worker spike

**Version:** v1  
**Verdict:** **D** (production) + bounded Option-A spike — see [`docs/codex-cli-worker.md`](../../docs/codex-cli-worker.md)  
**Goal:** Prove or kill Codex CLI (`codex exec`) as an alternative worker transport **without** replacing Chat + Cursor production workers.

**SSOT (product):** [`docs/codex-cli-worker.md`](../../docs/codex-cli-worker.md)  
**SSOT (versions):** [`docs/roadmap.md`](../../docs/roadmap.md) — this spike is **not** a `0.N.0`. Do **not** change `.planning/.active_plan` (0.6 remains next milestone).  
**Depends on:** local ChatGPT-authenticated `codex` CLI; existing stdio or `:8790/mcp` handoff server; same SQLite.

## Next Step

Live credit/concurrency probe (not MCP-feasibility theory, not production worker code).

## Non-goals

- Production `codex-worker` process or broker replacement
- Codex Desktop
- Option B (Codex as CDP/browser dispatcher)
- API-key / Platform billing path
- Changing 0.6 / 0.7 / 0.8 ladder
- Replacing `handoff_read_file` with Codex workspace access

## Invariants (P0)

- Wake with `TASK_ID=ho_…` only
- COMPLETED = `handoff_submit_result` only (not process exit / stdout)
- Read-only sandbox; empty cwd under `$HOME/.chatgpt-mcp/codex-worker`; `shell_tool = false`
- ChatGPT login, not `OPENAI_API_KEY`
- MCP allowlist only: get_task, get_task_status, submit_result, (later) read_file
- Same leases/fencing/timeouts semantics if a worker is later wired

## Spike steps (≤1 day)

1. `codex login` + `codex login status` — kill if Platform billing is required
2. Isolated worker home + MCP config (`required = true`, allowlist, read-only, no shell, `web_search = "live"`)
3. `codex exec --ephemeral --sandbox read-only --json --cd … "TASK_ID=ho_…"`
4. Matrix: 5 each of `second_opinion`, `code_review`, `debug_analysis`, `research`; then 3 simultaneous × 5 rounds
5. Record p50/p95 TASK_ID→submit_result, credits/task, credits n=1 vs n=3

Success / kill criteria: [`docs/codex-cli-worker.md`](../../docs/codex-cli-worker.md) and [`findings.md`](findings.md) §17–20.

## After the spike

| Result | Action |
|--------|--------|
| n=3 quota-blocked or credits unsustainable | Close Codex branch; keep **D** |
| Credits OK, research worse than Chat | Consider **C** only (Codex for review/debug) |
| Credits OK + research OK + submit reliability | Revisit **A** as a future version — still a separate roadmap decision |
