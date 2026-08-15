# Roadmap

> Sole source of truth for **version scope and exit criteria**.  
> Execution details live in `.planning/`. Dates are not commitments.

## Versioning rule

| Pattern | Meaning |
|---------|---------|
| **`0.N.0`** | Feature / milestone release (preview tags: `0.N.0-preview`) |
| **`0.N.M`** (`M ≥ 1`) | Bug fixes / patches on that line only — **not** new features |

Do **not** use `0.N.x` as a feature bucket. Big capabilities each get their own `0.N.0`.

## Product direction

Local-first Cursor/agent ↔ ChatGPT handoff over MCP: independent review, research, and second opinions without scraping the ChatGPT DOM. Priorities: correctness, consent, reproducible evidence — then more hosts and workers.

## Support snapshot

| Surface | Status | Evidence |
|---------|--------|----------|
| Cursor + macOS + Chrome CDP | Supported (developer preview) | Transport canary; E2E in-repo |
| Claude Code / other MCP hosts | Experimental | Manual poll by `taskId` |
| Ubuntu desktop | Experimental | Not Snap/WSL/headless |
| Windows / WSL / headless | Not supported | — |
| Multi-worker | Not started | Deferred to **0.5.0** |

## Sequencing principles

- Correctness does **not** depend on host stop hooks.
- Server-generated `taskId` is authoritative; session ids are optional.
- Evidence precedes support claims (“works with X”).
- UI automation fails closed; login / consent stay manual.
- One `0.N.0` must meet exit criteria before the next feature version is claimed.

## Version ladder

| Version | Outcome | P0 scope | Exit criteria | Explicitly deferred |
|---------|---------|----------|---------------|---------------------|
| **0.1.0** | Reproducible Cursor/macOS preview | setup/start/check, scrubbed public source, transport canary, honest limitations | Tagged preview; stranger ≤15 min path documented; no secret paths in repo | Multi-host API, concurrency, agent auto-policy |
| **0.2.0** | Agent UX: auto-trigger MCP + auto-adjust thinking effort | Cursor skill/rule decision policy; Light/Standard/Deep; frozen trigger scenarios | Scenario set passes; ≤1 handoff/decision; reason recorded; trivial tasks skip | Host-generic product “chooser”; fake effort knobs without host API |
| **0.3.0** | Portable core | Optional `clientSessionId`; `taskId` authoritative; core ≠ host adapters | Create with/without session; Cursor UX preserved; docs/skills updated | Supported Claude polish |
| **0.4.0** | Claude host | Claude skill/hook equivalent; E2E by `taskId` | Documented Claude path + clean evidence run | Multi-worker |
| **0.5.0** | Static multi-worker + operability | Two configured workers; leases, heartbeats, fencing; stable IDs; observability | 2 workers, concurrency 1 each; crash recovery; usable ops signals | Dynamic pool |
| **0.6.0** | Assisted provisioning | Guided wizard + handshake; READY only after E2E | User still does login/approvals; no cookie automation | Unattended UI create |

### 0.2.0 — Agent UX (ASAP)

Ship as its own feature release (not a patch on 0.1.0). Prefer **skill/rule policy**, not core queue logic.

#### Auto-trigger MCP (agent-initiated handoff policy)

Trigger when one or more apply:

- Independent review materially reduces risk
- Needs current external research
- ≥2 failed local debug hypotheses
- Architecture / security / release ambiguity
- User explicitly asks for ChatGPT / handoff

Skip: trivial/deterministic edits, answer already in repo, latency > value.

Rules: at most **one** handoff per decision point; end turn after create (stop hook); never hand off a handoff result.

#### Auto-adjust thinking effort

Internal task classes (policy — not a fake “max tokens” knob):

| Class | Local behavior | Handoff |
|-------|----------------|---------|
| Light | Brief; verify locally | Never unless requested |
| Standard | Normal plan + tests | Only after uncertainty / failure trigger |
| Deep | Explicit hypotheses + evidence | Independent handoff when it adds value |

If a host later exposes a real effort/reasoning control, map it in the **host adapter** — not the core queue. Optional later metadata: `taskClass`, `handoffReason` for evaluation only.

## Current milestone

- **Product next:** **0.2.0** agent UX (auto-trigger + effort policy).
- **In flight (code):** portable-core work tracked toward **0.3.0** — local package may still say `0.2.0-preview.0` until renamed to match this ladder.
- **Active engineering plan:** [`.planning/2026-08-13-portable-core-0-2/`](../.planning/2026-08-13-portable-core-0-2/task_plan.md) → roadmap target **0.3.0**.
- **Docs/plans hygiene:** [`.planning/2026-08-13-docs-org-roadmap/`](../.planning/2026-08-13-docs-org-roadmap/task_plan.md) (complete).
- **0.1.0 evidence gaps:** A/B bench scores pending ([benchmark/results.md](benchmark/results.md)); stranger onboarding ([onboarding-timing.md](onboarding-timing.md)).

## Near-term queue

1. Implement **0.2.0** (Cursor skill/rule + scenario fixtures) — ASAP.
2. Close remaining **0.1.0** evidence (bench + timing) without blocking 0.2.0.
3. Finish / tag **0.3.0** portable core (rename package from misaligned `0.2.0-preview.0` when tagging).
4. **0.4.0** Claude → **0.5.0** multi-worker → **0.6.0** assisted provisioning.

## Deferred / non-goals

| Item | Reconsider at |
|------|----------------|
| Dynamic worker pool | After **0.5.0** leases/fencing |
| Auto-login / cookie export / auto-approve writes | Never as default; **0.6.0** only with explicit consent UX |
| “Works with all coding agents” claim | After each host has evidence |
| Marketplace / Windows | After macOS+Cursor bar is solid |
| Unattended ChatGPT chat creation | Prefer assisted wizard (**0.6.0**) |

## Decision log

| Date | Decision | Reason | Supersedes |
|------|----------|--------|------------|
| 2026-08-13 | `docs/roadmap.md` is sole version SSOT | Avoid dual authority with `.planning` notes | `.planning/2026-08-13-future-versions.md` |
| 2026-08-13 | Auto-trigger + effort = skill/rule first | Product server cannot infer host task difficulty | Building chooser into core queue |
| 2026-08-13 | Feature milestones are **`0.N.0` only**; minors = bugfix | Large features must not hide under `0.N.x` | Prior `0.1.x` / `0.2.x` feature buckets |
| 2026-08-13 | Ladder: 0.1.0 preview → **0.2.0 agent UX** → 0.3.0 portable → 0.4.0 Claude → 0.5.0 multi-worker → 0.6.0 provisioning | ASAP vibe-coding features get a full version | ChatGPT draft that nested UX under 0.1.x; old 0.2.0=portable numbering |
