# Roadmap

> **WHAT + WHY + ORDER.** Dates are not commitments.  
> **HOW + acceptance:** [active/](active/) · **UNKNOWN + evidence:** [experiments/](experiments/) · **DECISION:** [decisions/](decisions/)

## Version ladder

| Version | Name | Status |
|---------|------|--------|
| 0.1 | Reproducible preview | SHIPPED |
| 0.2 | Static multi-worker | SHIPPED |
| 0.3 | CDP optimize + create-worker | SHIPPED |
| 0.4 | Ops dashboard | SHIPPED |
| 0.5 | Agent UX + chat rotation | SHIPPED |
| 0.6 | Worker Control Plane | SHIPPED |
| 0.7 | Handoff Resources (P0) | SHIPPED — exit debt → 0.7.x |
| 0.8 | **Handoff Resources Phase 2 (writeback)** | **ACTIVE** — branch `feat/0.8-writeback` |
| 0.9 | MCP Resource URI transport | PLANNED |
| 0.10 | Audit store + read API revival | PLANNED |
| 0.11 | Claude host | PLANNED |
| — | **Dashboard 1.0** (React rebuild) | **ACTIVE (design gate)** — [spec](active/dashboard-react-rebuild.md) · [review](2026-09-02-dashboard-react-rebuild/design-review.md) |

Handoff Resources spans **0.7–0.10** as one feature family; new hosts after resource semantics are evidence-backed.

## Active

1. **[0.7.x patch](./active/0.7-handoff-resources.md)** — rotation CI, formal E2E D1–D3/D1b, #18, tag `v0.7.0`
2. **[0.8 — Handoff Resources Phase 2](active/0.8-handoff-resources-phase2.md)** — writeback + large-batch observability + lifecycle hardening

Core principle: **Agent chooses context; runtime chooses transport.**

## Product direction

Local-first Cursor/agent ↔ ChatGPT handoff over MCP. Priorities: correctness, consent, reproducible evidence — then **complete handoff resources**, then more hosts.

## Sequencing principles

- Correctness does **not** depend on host stop hooks.
- Server-generated `taskId` is authoritative.
- UI automation fails closed; login / consent stay manual.
- One `0.N.0` must meet exit criteria before the next feature version is claimed.
- Evidence precedes support claims (“works with X”).

## Reconciliation (2026-09-01)

Aug 30 ladder placed Claude at 0.8 while the 0.7 spec deferred remaining resource work to “v0.8+”. **Superseded:** 0.8 = HR Phase 2; Claude → 0.11. Source: handoff `ho_01M1EDZR3R94ZD8SC8BW61WS2H`.

## Archive

| Version | Note |
|---------|------|
| [0.6 portable core (absorbed)](archive/0.6-portable-core.md) | Shipped in 0.5.x baseline |
| [0.5 agent UX](archive/0.5-agent-ux.md) | Shipped `v0.5.0` |

## Public mirror

[`docs/roadmap.md`](../docs/roadmap.md)
