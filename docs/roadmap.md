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

Local-first Cursor/agent ↔ ChatGPT handoff over MCP: independent review, research, and second opinions without scraping the ChatGPT DOM. Priorities: correctness, consent, reproducible evidence — then **more workers** and assisted provisioning, then more hosts and agent UX policy.

## Support snapshot

| Surface | Status | Evidence |
|---------|--------|----------|
| Cursor + macOS + Chrome CDP | Supported (developer preview) | Transport canary; E2E in-repo |
| Claude Code / other MCP hosts | Experimental | Manual poll by `taskId` |
| Ubuntu desktop | Experimental | Not Snap/WSL/headless |
| Windows / WSL / headless | Not supported | — |
| Multi-worker | Not started | Target **0.2.0** |

## Sequencing principles

- Correctness does **not** depend on host stop hooks.
- Server-generated `taskId` is authoritative; session ids are optional.
- Evidence precedes support claims (“works with X”).
- UI automation fails closed; login / consent stay manual.
- One `0.N.0` must meet exit criteria before the next feature version is claimed.
- **Leases / fencing before auto-provisioning** — assisted create (0.3.0) assumes multi-worker ops from 0.2.0.

## Version ladder

| Version | Outcome | P0 scope | Exit criteria | Explicitly deferred |
|---------|---------|----------|---------------|---------------------|
| **0.1.0** | Reproducible Cursor/macOS preview | setup/start/check, scrubbed public source, transport canary, honest limitations | Tagged preview; stranger ≤15 min path documented; no secret paths in repo | Multi-host API, concurrency, agent auto-policy |
| **0.2.0** | Static multi-worker + operability | Two+ configured workers; leases, heartbeats, fencing; stable worker IDs; observability | ≥2 workers, concurrency 1 each; crash recovery; usable ops signals (`make status` / health) | Dynamic pool; auto-create chats |
| **0.3.0** | Assisted worker provisioning | Guided wizard + handshake; READY only after E2E smoke | User still does ChatGPT login + MCP write approvals; no cookie / auto-approve automation | Unattended CDP chat creation |
| **0.4.0** | Agent UX: auto-trigger MCP + thinking effort | Cursor skill/rule decision policy; Light/Standard/Deep; frozen trigger scenarios | Scenario set passes; ≤1 handoff/decision; reason recorded; trivial tasks skip | Host-generic product “chooser”; fake effort knobs |
| **0.5.0** | Portable core | Optional `clientSessionId`; `taskId` authoritative; core ≠ host adapters | Create with/without session; Cursor UX preserved; docs/skills updated | Supported Claude polish |
| **0.6.0** | Claude host | Claude skill/hook equivalent; E2E by `taskId` | Documented Claude path + clean evidence run | Marketplace / Windows |

### 0.2.0 — Static multi-worker (next)

Ship as its own feature release. Prefer **explicit worker configs** (env / file), not a dynamic cloud pool.

#### P0

- Register ≥2 workers (separate CDP endpoints and/or worker chat URLs)
- Claim with **leases** + heartbeat; fencing so a dead worker cannot double-dispatch
- Concurrency **1 task per worker**
- Ops: list workers, status, recover stuck leases (`make` / HTTP)
- Crash recovery: `DISPATCHING` / lease expiry → requeue or fail-closed

#### Non-goals for 0.2.0

- Auto-creating ChatGPT conversations
- Auto-login or auto-approving MCP writes
- Elastic / dynamic worker pool

### 0.3.0 — Assisted provisioning (“auto-create workers”)

**Consent model (A):** wizard guides the human; system does **not** silently create sessions.

- Steps: create/open worker chat → paste URL → connect remote MCP / tunnel → approve write tools → run canary → mark READY
- Optional CDP assist that opens ChatGPT UI, but **login and write approval remain manual**
- READY only after a successful E2E canary (create → dispatch → submit → get result)

Never as default: cookie export, password automation, auto-click MCP approve.

### 0.4.0 — Agent UX (deferred)

Formerly the ASAP “0.2.0” slot. Prefer **skill/rule policy**, not core queue logic.

Trigger handoff when independent review / live research / repeated debug failure / architecture ambiguity / user asks. Skip trivial work. At most one handoff per decision; end turn after create when stop hook present.

Task classes Light / Standard / Deep map local effort; handoff only when it adds value. Host effort APIs belong in adapters later.

## Current milestone

- **Product next:** **0.2.0** static multi-worker (leases, heartbeats, fencing, ops).
- **Then:** **0.3.0** assisted worker provisioning (wizard + manual consent).
- **Deferred after that:** **0.4.0** agent UX → **0.5.0** portable core → **0.6.0** Claude host.
- **Package note:** local `package.json` may still say `0.2.0-preview.0` until multi-worker work lands; rename/tag when 0.2.0 exit criteria are met.
- **0.1.0 evidence gaps:** A/B bench scores pending ([benchmark/results.md](benchmark/results.md)); stranger onboarding ([onboarding-timing.md](onboarding-timing.md)).

## Near-term queue

1. Spec + implement **0.2.0** multi-worker (lease model, dual-worker E2E).
2. Spec + implement **0.3.0** assisted provisioning wizard (consent model A).
3. Close remaining **0.1.0** evidence (bench + timing) without blocking 0.2.0.
4. Then **0.4.0** agent UX → **0.5.0** portable core → **0.6.0** Claude.

## Deferred / non-goals

| Item | Reconsider at |
|------|----------------|
| Dynamic worker pool | After **0.2.0** leases/fencing are proven |
| Auto-login / cookie export / auto-approve writes | Never as default; only with explicit consent UX in **0.3.0+** |
| Unattended ChatGPT chat creation via CDP | Prefer assisted wizard (**0.3.0**); revisit only with strong fail-closed UX |
| “Works with all coding agents” claim | After each host has evidence (**0.6.0+**) |
| Marketplace / Windows | After macOS+Cursor multi-worker bar is solid |

## Decision log

| Date | Decision | Reason | Supersedes |
|------|----------|--------|------------|
| 2026-08-15 | Ladder: 0.1.0 → **0.2.0 multi-worker** → **0.3.0 assisted provision** → 0.4.0 agent UX → 0.5.0 portable → 0.6.0 Claude | Operator priority: scale workers before vibe-coding policy | 2026-08-13 ladder (agent UX ASAP as 0.2.0; multi-worker as 0.5.0) |
| 2026-08-15 | 0.3.0 = wizard + manual login/MCP approve (model A) | Fail-closed consent; avoid brittle unattended CDP create | Unattended auto-create as default |
| 2026-08-13 | `docs/roadmap.md` is sole version SSOT | Avoid dual authority with `.planning` notes | `.planning/2026-08-13-future-versions.md` |
| 2026-08-13 | Auto-trigger + effort = skill/rule first | Product server cannot infer host task difficulty | Building chooser into core queue |
| 2026-08-13 | Feature milestones are **`0.N.0` only**; minors = bugfix | Large features must not hide under `0.N.x` | Prior `0.1.x` / `0.2.x` feature buckets |
