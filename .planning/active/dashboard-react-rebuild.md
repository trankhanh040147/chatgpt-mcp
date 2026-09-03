# Dashboard React rebuild — spec

**Status:** Active — **design-complete gate** (no React port until Figma sign-off)  
**Date:** 2026-09-02 · updated 2026-09-03  
**Product line:** Dashboard **1.0**  
**ADR:** [ADR-010](../decisions/ADR-010-dashboard-react-rebuild.md)

## Policy (2026-09-03)

**Complete design in Figma first** — semantics + craft + motion + ⌘K + themes + all scenario frames.

React implementation **blocked** until master checklist in [figma-make-final.prompt.md](../2026-09-02-dashboard-react-rebuild/figma-make-final.prompt.md) is signed off.

## Single handoff doc

| Doc | Purpose |
|-----|---------|
| **[figma-make-final.prompt.md](../2026-09-02-dashboard-react-rebuild/figma-make-final.prompt.md)** | **Paste this into Figma Make** — master prompt |
| [design-review-v2.md](../2026-09-02-dashboard-react-rebuild/design-review-v2.md) | Engineering review history |
| [backend-craft-backlog.md](../2026-09-02-dashboard-react-rebuild/backend-craft-backlog.md) | API fields to implement after UI |

Supersedes: `figma-make-revision.prompt.md`, `figma-make-revision-v3.prompt.md`, `figma-make-craft-pass.prompt.md` (keep for history).

## Decisions

| Decision | Choice |
|----------|--------|
| Sequencing vs 0.8 | Parallel `feat/dashboard-react` off `main` |
| IA | Make redesign — light default, tabs, activity feed on Overview |
| Stack | Port Make source — React 19 + Vite + Tailwind v4 |
| Themes | Light + Dark + Dim + System — design all in Figma |
| Coexistence | Vanilla at `/dashboard/` until cutover phase 4 |
| Craft | Titles, repo, hero, ⌘K, motion spec — **in design scope** |

## Phases (revised)

| Phase | Scope | Exit |
|-------|-------|------|
| **0 — Design complete** | Final Make pass + your sign-off | All Part M frames + master checklist ✅ |
| **1 — Scaffold** | Vite + React, separate dev path | Build runs |
| **2 — Read path** | Poll, all tabs, themes, feed | Matches Figma |
| **3 — Mutations + ⌘K + motion** | Ops, palette, transitions | Parity tests |
| **4 — Cutover** | Replace vanilla | `verify` green |

## References

- [Figma Make file](https://www.figma.com/make/GdV7zzx4CjYqKrUEp24O29/Create-Design-from-Spec?t=vAndgFVMumHk4Q4m-1)
- [docs/dashboard.md](../../docs/dashboard.md)
