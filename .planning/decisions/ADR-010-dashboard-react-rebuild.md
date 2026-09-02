# ADR-010 — Dashboard frontend: React rebuild (dash 1.0)

**Status:** Accepted (design gate active)  
**Date:** 2026-08-31 (proposed) · 2026-09-02 (grilling confirmed)

## Context

Ops dashboard shipped as vanilla HTML/JS (~2100 LOC). Figma Make produced a light-theme React prototype with improved IA. Backend APIs stable after 0.6 worker control plane.

## Decision

1. Rebuild UI in **React 19 + Vite + Tailwind v4**, porting Make source after design sign-off.
2. **Freeze HTTP API** for dash 1.0.
3. Adopt Make IA: tabs (Overview / Tasks / Diagnostics), light theme, technical details in drawers.
4. **Vanilla remains** at `/dashboard/` until full parity cutover.
5. **Design sign-off blocks** code adapt merge.

## Consequences

- Dev deps: React, Vite, Tailwind
- Pure UI logic extracted to testable TS modules
- Design iteration via Figma Make before engineering port

## Related

- [dashboard-react-rebuild.md](../active/dashboard-react-rebuild.md)
- [design-review.md](../2026-09-02-dashboard-react-rebuild/design-review.md)
