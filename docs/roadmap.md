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
| Multi-worker | **0.2.0** | Leases + fencing + status-api; dual CDP E2E |

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
| **0.2.0** | Static multi-worker + operability | Two+ configured workers; leases, heartbeats, fencing; stable worker IDs; observability | ≥2 workers, concurrency 1 each; crash recovery; usable ops signals (`make status` / health) | Dynamic pool; auto-create chats; single-CDP multi-tab |
| **0.3.0** | CDP optimize + assisted create-worker | Fewer Chrome processes / on-demand CDP where safe; guided create/register worker chat; READY after canary | Operator can add a worker without hand-editing only; RAM/workspace cost down vs naïve N Chromes; login + MCP approve still manual | Unattended cookie/login; elastic cloud pool |
| **0.4.0** | Agent UX: auto-trigger MCP + thinking effort | Cursor skill/rule decision policy; Light/Standard/Deep; frozen trigger scenarios | Scenario set passes; ≤1 handoff/decision; reason recorded; trivial tasks skip | Host-generic product “chooser”; fake effort knobs |
| **0.5.0** | Portable core | Optional `clientSessionId`; `taskId` authoritative; core ≠ host adapters | Create with/without session; Cursor UX preserved; docs/skills updated | Supported Claude polish |
| **0.6.0** | Claude host | Claude skill/hook equivalent; E2E by `taskId` | Documented Claude path + clean evidence run | Marketplace / Windows |

### 0.2.0 — Static multi-worker (**shipped**)

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
- Collapsing N workers onto **one** Chrome/CDP (accepted cost for 0.2.0; moved to **0.3.0**)

### 0.3.0 — CDP optimize + assisted create-worker (**next**)

Combines two operator pain points left after 0.2.0:

1. **CDP fan-out cost** — N Chrome windows burn RAM and desktop space.
2. **Create / register worker** — today is manual URL + profile setup.

**Consent model (A)** for provisioning: wizard guides the human; system does **not** silently create sessions or approve writes.

#### P0

- **CDP optimize (pick + ship at least one proven path):**
  - multi-tab / single-browser dispatcher with composer isolation, and/or
  - on-demand CDP (start profile when claiming, stop when idle), and/or
  - minimized/background Chrome where ChatGPT session stays valid
- **Assisted create-worker:** create/open chat → capture URL → wire topology (`workers.json` / env) → optional tunnel check → approve write tools (manual) → canary → READY
- Keep fence-before-type, leases, and no cross-talk on composers

#### Non-goals for 0.3.0

- Cookie export / password automation / auto-click MCP approve
- Elastic cloud worker pool
- Changing the pull-queue model (create still enqueues; idle workers claim) — admission control (“no idle worker → reject”) is optional stretch, not required to tag 0.3.0

### 0.4.0 — Agent UX (deferred)

Formerly the ASAP “0.2.0” slot. Prefer **skill/rule policy**, not core queue logic.

Trigger handoff when independent review / live research / repeated debug failure / architecture ambiguity / user asks. Skip trivial work. At most one handoff per decision; end turn after create when stop hook present.

Task classes Light / Standard / Deep map local effort; handoff only when it adds value. Host effort APIs belong in adapters later.

## Current milestone

- **Shipped:** **0.1.0** (macOS/Cursor developer preview) and **0.2.0** (static multi-worker: leases, fencing, dual CDP E2E).
- **Product next:** **0.3.0** — CDP fan-out optimization + assisted create-worker (see below).
- **Deferred after that:** **0.4.0** agent UX → **0.5.0** portable core → **0.6.0** Claude host.
- **0.1.0 evidence gaps (non-blocking):** A/B bench scores ([benchmark/results.md](benchmark/results.md)); stranger onboarding ([onboarding-timing.md](onboarding-timing.md)).

## Near-term queue

1. Spec + implement **0.3.0** (CDP optimize + create-worker wizard).
2. Close remaining **0.1.0** evidence (bench + timing) without blocking 0.3.0.
3. Then **0.4.0** agent UX → **0.5.0** portable core → **0.6.0** Claude.

## Deferred / non-goals

| Item | Reconsider at |
|------|----------------|
| Dynamic worker pool | After **0.3.0** create-worker path is proven |
| Auto-login / cookie export / auto-approve writes | Never as default; only with explicit consent UX in **0.3.0+** |
| Unattended ChatGPT chat creation via CDP | Prefer assisted wizard (**0.3.0**); revisit only with strong fail-closed UX |
| “Works with all coding agents” claim | After each host has evidence (**0.6.0+**) |
| Marketplace / Windows | After macOS+Cursor multi-worker bar is solid |

### CDP fan-out (moved into **0.3.0**)

**Problem (2026-08-15):** Static multi-worker requires **one Chrome CDP profile + port + worker chat per browser-worker**. Correct for isolating composer/UI, but scales poorly: RAM, window clutter, and operator workspace.

**0.2.0 stance (shipped):** Keep separate CDPs. Do not share one Chrome across two `browser-worker` processes.

**0.3.0 work:** Ship a safer CDP footprint (multi-tab dispatcher and/or on-demand CDP) **together with** assisted create-worker. Keep fence-before-type, no cross-talk on composers, fail-closed consent.

## Decision log

| Date | Decision | Reason | Supersedes |
|------|----------|--------|------------|
| 2026-08-16 | **0.2.0 shipped**; **0.3.0** = CDP optimize + assisted create-worker | Dual E2E + lease PASS; operator asked to pull CDP fan-out into next milestone with provisioning | 2026-08-15 “fewer CDPs deferred unscheduled”; 0.3.0 provisioning-only |
| 2026-08-15 | Ladder: 0.1.0 → **0.2.0 multi-worker** → **0.3.0 assisted provision** → 0.4.0 agent UX → 0.5.0 portable → 0.6.0 Claude | Operator priority: scale workers before vibe-coding policy | 2026-08-13 ladder (agent UX ASAP as 0.2.0; multi-worker as 0.5.0) |
| 2026-08-15 | 0.2.0 keeps **1 CDP Chrome per worker**; “fewer CDPs / less RAM” deferred post-0.2.0 | Dual E2E needs isolated composers; N Chrome is costly — redesign later (multi-tab dispatcher / on-demand CDP) | — |
| 2026-08-15 | 0.3.0 = wizard + manual login/MCP approve (model A) | Fail-closed consent; avoid brittle unattended CDP create | Unattended auto-create as default |
| 2026-08-13 | `docs/roadmap.md` is sole version SSOT | Avoid dual authority with `.planning` notes | `.planning/2026-08-13-future-versions.md` |
| 2026-08-13 | Auto-trigger + effort = skill/rule first | Product server cannot infer host task difficulty | Building chooser into core queue |
| 2026-08-13 | Feature milestones are **`0.N.0` only**; minors = bugfix | Large features must not hide under `0.N.x` | Prior `0.1.x` / `0.2.x` feature buckets |
