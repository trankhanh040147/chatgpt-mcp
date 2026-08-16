# Task plan — 0.3.0

**Goal:** Cut CDP RAM/workspace cost vs naïve N Chromes, and make adding a worker a guided flow (login + MCP approve still manual).

## Tracks

### A — CDP optimize
1. Measure baseline: RSS / window count for 1 vs 2 CDP Chromes
2. Prototype candidates (pick one primary):
   - **A1** Single Chrome, multi-tab dispatcher (shared CDP, isolated pages)
   - **A2** On-demand CDP (spawn on claim, tear down when idle)
   - **A3** Minimized / app-hidden Chrome (still headed; less clutter)
3. Keep invariants: fence-before-type, no composer cross-talk, lease CAS
4. Dual-logical-worker E2E under the chosen footprint

### B — Assisted create-worker
1. CLI/wizard: new chat via CDP assist → capture `/c/…` URL
2. Write/update `workers.json` + profile dir + port allocation
3. Prompt human for MCP write approve + tunnel check
4. Canary → mark READY; fail-closed if canary fails

### C — Docs / ops
1. Update architecture + onboarding for 0.3 flows
2. `make doctor` understands optimized topology

## Non-goals
- Auto-login / cookie export / auto-click approve
- Elastic cloud pool
- Must-have admission control on `handoff_create_task` (stretch only)
