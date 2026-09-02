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
| 0.6 | **Worker Control Plane** (lite ops + dashboard + `gptmcp` CLI) | **ACTIVE** |
| 0.7 | **Handoff Resources** | **ACTIVE** (impl on branch) |
| 0.8 | Claude host | PLANNED |
| 0.9 | Result artifacts | CANDIDATE |
| — | **Dashboard 1.0** (React rebuild) | **PROPOSED** — [spec](active/dashboard-react-rebuild.md) · [ADR-010](decisions/ADR-010-dashboard-react-rebuild.md) |

## Active

1. **[0.6 — Worker Control Plane](active/0.6-worker-ops.md)** — durable ops journal, broker HTTP, SYSTEM_PROBE, extend existing dashboard. **Ship first.**
2. **[0.7 — Handoff Resources](active/0.7-handoff-resources.md)** — native file attach + snapshot. **PR after 0.6 recommended.**

Core principle (0.7): **Agent chooses context; runtime chooses transport.**

## Product direction

Local-first Cursor/agent ↔ ChatGPT handoff over MCP. Priorities: correctness, consent, reproducible evidence — then **worker ops**, **handoff resources**, then more hosts.

## Sequencing principles

- Correctness does **not** depend on host stop hooks.
- Server-generated `taskId` is authoritative.
- UI automation fails closed; login / consent stay manual.
- One `0.N.0` must meet exit criteria before the next feature version is claimed.

## Archive

| Version | Note |
|---------|------|
| [0.6 portable core (absorbed)](archive/0.6-portable-core.md) | Shipped in 0.5.x baseline |
| [0.5 agent UX](archive/0.5-agent-ux.md) | Shipped `v0.5.0` |

## Public mirror

[`docs/roadmap.md`](../docs/roadmap.md)
