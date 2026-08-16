# Task plan — 0.3.0

**Goal:** Cut CDP RAM/workspace cost vs naïve N Chromes, and make adding a worker a guided flow (login + MCP approve still manual).

## Tracks

### A — CDP optimize
1. Measure baseline: RSS / window count for 1 vs 2 CDP Chromes
2. **Locked direction:** **A1-S** — exclusive browser-broker + N tabs + **narrow global mutex only for fence+type/send** (not full concurrent A1(i); not A1(ii))
3. Run A1-S spike in findings.md; pass kill criteria or fall back to N headed
4. Dual-logical-worker E2E under broker footprint (PROCESSING may overlap; UI writes serialize)
5. Headless-per-worker / A2 / fully concurrent writes = later/experimental only

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
