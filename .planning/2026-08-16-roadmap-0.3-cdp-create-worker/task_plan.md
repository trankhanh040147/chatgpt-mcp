# Task plan — 0.3.0

**Goal:** Cut CDP RAM/workspace cost vs naïve N Chromes, and make adding a worker a guided flow (login + MCP approve still manual).

## Tracks

### A — CDP optimize
1. Measure baseline: RSS / window count for 1 vs 2 CDP Chromes — **done (qualitative)**
2. **Locked direction:** **A1-S** — exclusive browser-broker + N tabs + **narrow global mutex only for assert+type/send**
3. Run A1-S spike — **done** (`spike:a1s`, live bind, dual E2E)
4. Dual-logical-worker E2E under broker — **done**
5. Headless-per-worker / A2 / fully concurrent writes = later/experimental only

### B — Assisted create-worker (**active**)
1. CLI: CDP assist → New chat → capture `/c/…` URL — **in progress**
2. Atomic write/update `workers.json` / `workers.a1s.json` (A1-S shared CDP default)
3. Prompt human for MCP write approve (never auto-click) + optional tunnel check
4. One-shot canary on the new page → exit non-zero if fail; print restart-broker note
5. `make doctor` understands shared-CDP (A1-S) topology

### C — Docs / ops
1. Update architecture + onboarding for create-worker flow
2. `make doctor` + `npm run create-worker`

## Non-goals
- Auto-login / cookie export / auto-click approve
- Elastic cloud pool
- Must-have admission control on `handoff_create_task` (stretch only)
- Hot-reload broker actors without restart (document restart)
