# Progress — Codex CLI worker spike

## Status: **not started** (docs + plan only)

Does **not** replace `.planning/.active_plan` (0.6 remains the product milestone).

| Phase | Status | Notes |
|-------|--------|-------|
| Research 2026-08-24 | done | Verdict **D**; sources in findings |
| ADR + spec/roadmap | done | `docs/codex-cli-worker.md` |
| `codex login` (ChatGPT, not API key) | not started | |
| Isolated worker config + localhost MCP | not started | |
| Sequential 20-task matrix | not started | submit_result is the only success signal |
| Burst n=3 credit probe | not started | primary experiment |
| Promote off D | blocked | needs credit PASS + explicit roadmap decision |

Next: live probe in `task_plan.md`. No production worker code until kill criteria are cleared.
