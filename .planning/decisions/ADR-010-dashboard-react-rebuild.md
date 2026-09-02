# ADR-010 — Dashboard frontend: React rebuild (dash 1.0)

**Status:** Proposed  
**Date:** 2026-08-31

## Context

The ops dashboard shipped in 0.4–0.6 as vanilla HTML/CSS/JS (`src/dashboard/public/app.js`, ~2100 LOC). It meets functional requirements (read + guarded mutations, worker ops, usage estimates) but:

- UI state, DOM rendering, and API polling are tightly coupled
- No component reuse; every poll re-renders via manual DOM replacement
- Unit tests import from a browser-oriented `app.js` module
- A new visual design exists in Figma Make but was not engineered against live API shapes

Operator workflows and backend APIs are stable after 0.6 worker control plane work. A frontend-only rewrite can proceed without changing `status-api` routes or security model.

## Decision

1. **Rebuild the dashboard UI in React + TypeScript**, bundled with Vite, output to the same `/dashboard/` static path.
2. **Freeze the HTTP API contract** for dash 1.0 — no new endpoints required for the rewrite.
3. **Use the Figma Make prototype** ([link](https://www.figma.com/make/GdV7zzx4CjYqKrUEp24O29/Create-Design-from-Spec?t=vAndgFVMumHk4Q4m-1)) as the **visual starting point only**; run an engineering design review before implementation and update frames or written deltas as needed.
4. **Require full feature parity** with the vanilla UI before removing `app.js` (see [dashboard-react-rebuild.md](../active/dashboard-react-rebuild.md)).
5. **Extract pure logic** (taxonomy, heuristics, sorting) into testable TS modules under `src/dashboard/ui/state/`.

## Consequences

- Add dev dependency footprint (React, Vite, types) — acceptable for a maintainer-facing local tool
- `npm run build` gains a Vite step before copying to `dist/dashboard/public/`
- `scripts/test-dashboard-pr1.ts` imports move from `app.js` to shared state modules
- Design iteration becomes cheaper; backend team can ship ops endpoints independently

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| **Incremental refactor of `app.js`** | Still no components; poll/render coupling remains |
| **Lightweight framework (Preact, Lit)** | Team familiarity and ecosystem favor React; no strong size constraint |
| **Separate hosted frontend** | Violates local-first, loopback-only ops model |
| **Wait for perfect Figma frames** | 0.4 review showed Make invents states — derive states in code, iterate design in parallel |

## Related

- [ADR-008](./ADR-008-worker-ops-dashboard.md) — worker ops scope (backend — unchanged)
- [dashboard-react-rebuild.md](../active/dashboard-react-rebuild.md) — full spec + parity matrix
