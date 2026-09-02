# Dashboard React rebuild — spec

**Status:** Active (design gate)  
**Date:** 2026-09-02  
**Product line:** Dashboard **1.0**  
**ADR:** [ADR-010](../decisions/ADR-010-dashboard-react-rebuild.md)  
**Design review:** [2026-09-02/design-review.md](../2026-09-02-dashboard-react-rebuild/design-review.md)

## Decisions (grilling 2026-09-02)

| Decision | Choice |
|----------|--------|
| Sequencing vs 0.8 | Parallel branch `feat/dashboard-react` off `main` |
| IA | Adopt Figma Make redesign (light, tabs, simplified Overview) |
| Stack | Port Make source — React 19 + Vite + Tailwind v4 |
| Styling | Follow Make (Instrument Sans, JetBrains Mono) |
| Coexistence | Vanilla stays at `/dashboard/` until cutover phase 4 |
| Design gate | **Sign-off required** before merging code adapt |
| First deliverable | Design review + Figma Make revision prompt |

## Goal

Rebuild ops dashboard UI in React while preserving API contract and ops security model. See [design-review.md](../2026-09-02-dashboard-react-rebuild/design-review.md) for parity matrix and blockers.

## Phases

| Phase | Scope | Exit |
|-------|-------|------|
| **0 — Design** | Review Make + revision prompt → Figma sign-off | You approve frames |
| **1 — Scaffold** | Vite + React in `src/dashboard/ui/`, build to separate path | Dev build runs |
| **2 — Read path** | Poll hooks, Overview/Tasks/Diagnostics read-only | Matches Make layout |
| **3 — Mutations** | CSRF, ops modals, all `POST /ops/*` | `test:ops` + `test:worker-ops` |
| **4 — Cutover** | Replace vanilla at `/dashboard/` | `test:dashboard` green |

## Non-goals

Hosted SaaS, SSO, history charts, auto-scaling, silent GET mutations.

## References

- [docs/dashboard.md](../../docs/dashboard.md)
- [figma-make-revision.prompt.md](../2026-09-02-dashboard-react-rebuild/figma-make-revision.prompt.md)
- [Figma Make file](https://www.figma.com/make/GdV7zzx4CjYqKrUEp24O29/Create-Design-from-Spec?t=vAndgFVMumHk4Q4m-1)
