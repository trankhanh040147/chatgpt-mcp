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
| 0.6 | **Handoff Resources** | **ACTIVE** |
| 0.7 | Claude host | PLANNED |
| 0.8 | Result artifacts | CANDIDATE |

## Active

**[0.6 — Handoff Resources](active/0.6-handoff-resources.md)**

Agent selects workspace files at create → core snapshots into immutable task-scoped resources → runtime chooses transport → ChatGPT consumes.

Core principle: **Agent chooses context; runtime chooses transport.**

## Product direction

Local-first Cursor/agent ↔ ChatGPT handoff over MCP: independent review, research, and second opinions without scraping the ChatGPT DOM. Priorities: correctness, consent, reproducible evidence — then more workers, ops visibility, **handoff resources**, then more hosts.

## Sequencing principles

- Correctness does **not** depend on host stop hooks.
- Server-generated `taskId` is authoritative; session ids are optional.
- Evidence precedes support claims.
- UI automation fails closed; login / consent stay manual.
- One `0.N.0` must meet exit criteria before the next feature version is claimed.

## Parallel (not a version)

| Spike | Doc |
|-------|-----|
| Codex CLI worker | [experiments/codex-worker.md](experiments/codex-worker.md) |
| MCP resource transport | [experiments/mcp-resource-transfer.md](experiments/mcp-resource-transfer.md) |
| Context-pack transport | [experiments/context-pack.md](experiments/context-pack.md) |

Production workers stay **Chat + Cursor** until experiments prove otherwise.

## Archive

| Version | Note |
|---------|------|
| [0.6 portable core (absorbed)](archive/0.6-portable-core.md) | Shipped in codebase at 0.5.x baseline; no separate release |
| [0.5 agent UX](archive/0.5-agent-ux.md) | Shipped `v0.5.0` |

## Public mirror

User-facing copy and shipped-version detail: [`docs/roadmap.md`](../docs/roadmap.md) (mirrors ladder; defers spec to this tree).
