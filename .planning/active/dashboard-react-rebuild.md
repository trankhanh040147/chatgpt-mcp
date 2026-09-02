# Dashboard React rebuild — spec (proposed)

**Status:** Proposed (spec only — no implementation in this PR)  
**Date:** 2026-08-31  
**Product line:** Dashboard **1.0** (frontend rewrite; backend API unchanged)  
**ADR:** [ADR-010](../decisions/ADR-010-dashboard-react-rebuild.md)

## Goal

Rebuild the local ops dashboard as a **React SPA** with the **new Figma Make prototype** as the visual starting point, while preserving **100% behavioral parity** with the shipped vanilla UI (`src/dashboard/public/`).

The current dashboard (dash **0.1–0.6**) is functional but hard to extend: ~2k lines of imperative DOM in `app.js`, no component model, and UI logic mixed with fetch/poll/ops state. A React rebuild improves maintainability, testability, and design iteration — without changing the status-api contract or ops security model.

## Design source (prototype — not SSOT yet)

| Item | Value |
|------|-------|
| **Figma Make file** | [Create Design from Spec](https://www.figma.com/make/GdV7zzx4CjYqKrUEp24O29/Create-Design-from-Spec?t=vAndgFVMumHk4Q4m-1) |
| **Review status** | **Unreviewed prototype** — generated from spec prompts, not yet validated against real API payloads or operator workflows |
| **When implementing** | Run a **design review pass** with engineering: compare frames to live `/health`, `/workers`, `/workers/health`, `/tasks` JSON; fix invented commands, wrong ports, SaaS nav patterns, and fictional CTAs before treating any frame as SSOT |

> **Note:** The earlier 0.4 design file ([ChatGPT-MCP design](https://www.figma.com/design/gEbvBwguU9ZO3Oywv8fZGi/ChatGPT-MCP)) remains historical reference. The Make file above supersedes it **visually** for dash 1.0, subject to review.

### Design review checklist (gate before build)

- [ ] All copyable commands match project reality (`gptmcp start`, `gptmcp doctor`, `curl …/health`, `./scripts/start-broker-stack.sh`) — not `systemctl`, `docker-compose`, or wrong ports
- [ ] No left SaaS nav (DASHBOARD / WORKERS / TASKS tabs) unless explicitly re-scoped
- [ ] Task table columns: **Task ID · Status · Owner · Type · Age · Error** (not WORKER/DURATION-only variants)
- [ ] Worker cards expose: id, status, ops health, pid, heartbeat, current task, chat budget, condition chips
- [ ] State variants (OK / DEGRADED / SETUP / DOWN) are **derived in code** from API data — do not require separate Figma frames per state
- [ ] Destructive ops use confirm modal + CSRF — no silent buttons, no typed-phrase friction unless retained from 0.3
- [ ] Footer links (Documentation / Logs / Support) dropped unless wired to real docs
- [ ] Viewport target: **1440×900** minimum artboard; responsive down to ~1280 acceptable

## Current implementation (baseline)

| Path | Role |
|------|------|
| `src/dashboard/public/index.html` | Shell + regions (headline, workers, tasks, drawer, modals) |
| `src/dashboard/public/app.js` | Poll loop, taxonomy, worker ops, recover/fail-task, drawer |
| `src/dashboard/public/styles.css` | Sora + IBM Plex Mono tokens, grid background |
| `src/dashboard/observability.ts` | Shared server-side derivations (indicators, scrub, timing) |
| `src/http/api.ts` | Static serve at `/dashboard/` + JSON API |
| `scripts/test-dashboard-pr1.ts` | Unit tests for taxonomy / heuristics (imports from `app.js`) |

Served at `http://127.0.0.1:8787/dashboard/` (loopback only). See [docs/dashboard.md](../../docs/dashboard.md).

## Target architecture

```text
src/dashboard/
├── observability.ts          # unchanged — server shared logic
├── ui/                       # NEW — React source
│   ├── main.tsx
│   ├── App.tsx
│   ├── api/                  # fetch wrappers, CSRF session, poll hook
│   ├── components/           # presentational + container split
│   ├── hooks/
│   ├── state/                # taxonomy, worker sort, optimistic busy
│   └── styles/               # CSS modules or Tailwind (TBD at kickoff)
└── public/                   # built artifacts (or dist/dashboard/ui/)
```

### Build & serve

| Decision | Recommendation |
|----------|----------------|
| Bundler | **Vite** (fast dev, ESM-native, fits Node ≥22 repo) |
| React | **React 19** + TypeScript |
| Output | `dist/dashboard/public/` — same URL path, no operator URL change |
| Dev | `vite build` in `npm run build`; optional `npm run dev:dashboard` with proxy to `:8787` |
| Tests | Move pure functions from `app.js` → `src/dashboard/ui/state/*.ts`; keep `test:dashboard` on those modules |

`status-api` continues to serve static files from `dashboardPublicDir()` — only the **built** assets change.

### API contract (frozen — no backend work in dash 1.0)

Read endpoints (poll ~5s):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Control plane ok, lease reaper, counters |
| GET | `/workers` | Worker registry + runtime fields |
| GET | `/workers/health` | Ops health (`READY` / `DEGRADED` / `BLOCKED` / `OFFLINE`), condition chips |
| GET | `/tasks?limit=N` | Recent task list |
| GET | `/tasks/:id/detail` | Drawer timing + usage |
| GET | `/tasks/:id/content` | Redacted prompt/result (`HANDOFF_DASHBOARD_TASK_CONTENT=redacted`) |
| GET | `/ops/session` | CSRF token |
| GET | `/ops/topology` | Read-only topology (redacted CDP) |

Mutation endpoints (CSRF + Origin allowlist + confirm modal):

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/ops/recover/preview` | Blast-radius preview → `planToken` |
| POST | `/ops/recover` | Execute recover |
| POST | `/ops/tasks/fail` | Fail stuck task |
| POST | `/ops/workers/assign-url` | Set worker chat URL |
| POST | `/ops/workers/create-chat` | CDP new chat |
| POST | `/ops/workers/kill-recreate` | Kill binding + recreate |
| POST | `/ops/workers/set-enabled` | Enable/disable worker |
| POST | `/ops/workers/add` | Add worker slot |
| POST | `/ops/workers/remove` | Remove worker |
| POST | `/ops/workers/clear-stuck` | Clear stuck state |
| POST | `/ops/workers/continue-connection` | MCP consent continue |

Security invariants (must not regress):

- Loopback bind only; no auth SSO
- Mutations never from GET
- CSRF on all `POST /ops/*`
- Confirm modal before destructive ops
- `failOpen` remains CLI-only

## Feature parity matrix

Everything below exists in the vanilla UI and **must** ship in dash 1.0 before the old `app.js` is removed.

| Area | Parity requirement |
|------|-------------------|
| **System taxonomy** | `DOWN` / `SETUP` / `DEGRADED` / `OK` headline + recommended action |
| **Control plane strip** | Health pill, lease reaper, last tick, requeued / timed out / failed |
| **Worker cards** | Sort by attention; debug `<details>` persistence across poll |
| **Worker ops** | Assign URL, create chat, kill+recreate, enable/disable, add/remove, clear-stuck, continue |
| **Conditions** | PROCESS / BROKER / BINDING / URL / SESSION / MCP chips; `chatAccessDenied` banner |
| **Chat budget** | `tasks_on_chat / max`; warn at N−1; rotation readiness |
| **Tasks** | Recent list + drawer (timing, indicators, optional redacted content, fail-task) |
| **Recover** | Preview → confirm modal → execute (queued variant) |
| **Usage** | Token chips; optional reference $ (`HANDOFF_REFERENCE_PRICING`) |
| **Unreachable** | API-down panel + copyable commands |
| **Topology** | Read-only expand |
| **Broker down** | `BROKER:UNKNOWN` banner + port hint |

## Implementation phases

| Phase | Scope | Exit |
|-------|-------|------|
| **0 — Design review** | Walk Figma Make vs live API; update frames or written deltas | Signed-off component inventory |
| **1 — Scaffold** | Vite + React + TS; build → `dist/dashboard/public/`; empty shell renders | `npm run build` serves `/dashboard/` |
| **2 — Read path** | Poll hook, headline, workers, tasks, drawer (read-only) | Visual match + parity with unreachable/SETUP |
| **3 — Mutations** | CSRF, ops modals, recover/fail-task, worker ops | `test:ops` + `test:worker-ops` pass; manual M1 smoke |
| **4 — Cutover** | Delete vanilla `app.js`; migrate unit tests to `ui/state/` | `test:dashboard` green; docs updated |
| **5 — Polish** | Design tokens from Figma; a11y pass; keyboard modal trap | Design review sign-off |

**Sequencing relative to product milestones:** dash 1.0 is **independent** of 0.7 Handoff Resources and 0.8 Claude host. Recommended start **after 0.6.0 tag** (control plane stable) and **after 0.7 merge** if team capacity is limited — but not blocked on either.

## Non-goals (unchanged from 0.4–0.6)

- Hosted SaaS / multi-user auth / SSO
- History charts / metrics DB
- Auto-scaling workers from the UI
- Silent GET mutations
- Full desired-state `PATCH WorkerSpec` (imperative ops only)
- Replacing `gptmcp` CLI as primary ops surface

## Acceptance criteria (dash 1.0 tag)

1. `npm run verify` passes including migrated `test:dashboard`
2. Manual smoke: `gptmcp start` → `gptmcp open` → all worker ops + recover + fail-task on loopback
3. No regression in CSRF/origin enforcement (`test:ops`, `test:worker-ops`)
4. Bundle size reasonable for local tool (< ~500 KB gzipped target — soft)
5. Design review doc updated with deltas from Figma Make prototype

## Open questions (resolve at kickoff)

| # | Question | Default if no decision |
|---|----------|------------------------|
| 1 | CSS approach: CSS modules vs Tailwind vs vanilla CSS variables | CSS modules + design tokens from Figma |
| 2 | Co-locate `dashboard/ui/` vs top-level `apps/dashboard/` | Co-locate under `src/dashboard/ui/` |
| 3 | React Query vs custom poll hook | Custom hook (simple 5s poll, matches today) |
| 4 | Keep Sora + IBM Plex Mono fonts? | Yes unless Figma specifies otherwise |

## References

- [docs/dashboard.md](../../docs/dashboard.md) — operator guide (current)
- [ADR-008](../decisions/ADR-008-worker-ops-dashboard.md) — worker ops via dashboard
- [ADR-010](../decisions/ADR-010-dashboard-react-rebuild.md) — this rebuild decision
- [0.4 ops dashboard plan](../2026-08-16-roadmap-0.4-ops-dashboard/task_plan.md) — historical dash 0.x scope
- [Figma design review (0.4)](../2026-08-16-roadmap-0.4-ops-dashboard/figma-design-review.md) — lessons on Make vs engineering SSOT
