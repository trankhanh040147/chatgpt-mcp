# Task plan — 0.5.0 Agent UX + worker chat rotation

**Version:** v2 (post review `ho_01M092T4XGHW50Z6C39ENW8454`)  
**Verdict:** APPROVE_WITH_CHANGES → merged below  
**Goal:** Cursor agents hand off at the right depth (≤1 handoff/decision) and worker ChatGPT chats rotate before context pollution degrades quality — fail-closed when rotation cannot complete.

**SSOT:** `docs/roadmap.md` §0.5.0  
**Depends on:** 0.3 create-worker (Chat + Cursor plugin), 0.4 dashboard counts/indicators  
**Ops baseline (2026-08-18):** w1/w2/w3 on Chat+Cursor; burst `--n=3` PASS; A1-S broker + UI mutex.

---

## Frozen invariants (P0 — do not implement without these)

### Handoff policy

- One user-visible **decision** → at most **one** `handoff_create_task`.
- Light = **0** handoffs; Standard/Deep = **1** max for that decision.
- Insufficient result → continue locally or ask user; **no immediate re-handoff** of same decision.

### Rotation safety

- Rotation starts **only when worker is idle** (no claimed/in-flight task).
- Worker **cannot claim** while rotation pending, consent required, restart required, or rotation failed.
- Single serialized decision point: **idle → pre-claim gate** under broker scheduling lock (not ambiguous “pre-dispatch” after claim).

### Counter (`tasks_on_chat`)

- Budgets **chat usage**, not business success → count **dispatched** tasks (message sent to ChatGPT), including later FAILED/TIMED_OUT.
- Increment **once per task** at successful dispatch/send boundary; idempotent by task ID on retry.
- Do **not** count tasks that fail before any message is sent.
- Counter bound to **`{worker_id, chat_url}`** — persists across broker restart.
- Reset counter **only** in same durable transition that commits **new** chat URL (never reset before URL commit).

### Rotation ordering (crash-safe)

1. Create new chat (reuse `createWorkerChat`: Chat + Cursor).
2. Validate as far as consent model A permits (no auto-login/approve).
3. **Atomically** persist new URL + reset counter + audit fields (`previous_chat_url`, `chat_rotated_at`).
   - **Pre-commit “validate”** means: new Chat+Cursor chat was created and URL/profile structure is valid/recoverable — **not** that MCP approval/login is established (consent model A).
   - URL commit may proceed even if human MCP consent still required; worker stays `NOT_READY` with `CONSENT_REQUIRED` until operator completes approval, then `RESTART_REQUIRED` as applicable.
4. Mark worker `NOT_READY` + readiness reason `RESTART_REQUIRED` (or `CONSENT_REQUIRED` if human action needed first).
5. **Operator/supervisor** restarts broker (`start-broker-stack.sh`) — rotation does **not** self-restart broker process.
6. After restart + readiness satisfied → `READY`.

**Failure:** pre-commit → keep old URL + counter, fail-closed for new claims. Post-commit → keep new topology, remain NOT_READY until restart/recovery.

### Consent (model A)

- New chat without MCP approval = `CONSENT_REQUIRED`, NOT_READY — never dispatch into unverified chat.

---

## Exit criteria checklist (v0.5.0 tag)

- [ ] Rule + skill define Light/Standard/Deep consistently with examples
- [ ] Anti-loop invariant explicit (no re-handoff same decision)
- [ ] 12 scenarios in `scenarios-agent-ux.md` signed off in release evidence
- [ ] `test:agent-policy` static lint (rule/skill consistency)
- [ ] `HANDOFF_MAX_TASKS_PER_CHAT=20` default; invalid config fails validation
- [ ] Counter at dispatch boundary; includes FAILED/TIMED_OUT after send
- [ ] Counter persists across restart; tied to chat URL
- [ ] At count `< N` worker may claim; at `== N` cannot claim N+1 until rotation/recovery
- [ ] Rotation never on in-flight worker; manual CLI refuses busy
- [ ] URL committed before counter reset effective
- [ ] Fail-closed readiness reasons actionable
- [ ] CONSENT_REQUIRED path documented and tested
- [ ] Broker restart path tested; loads new URL + counter
- [ ] Crash injection: pre-commit preserves old; post-commit fail-closed
- [ ] Concurrent threshold hits: serialized topology writes, no clobber
- [ ] Dashboard capacity informational (`18/20`, restart required, failure reason)
- [ ] Live manual rotation (Chat+Cursor)
- [ ] Live threshold rotation (low test threshold)
- [ ] Post-rotation `burst --n=3` PASS
- [ ] Existing test suite green
- [ ] Roadmap/docs recovery procedure

---

## Track A — Agent UX (Light / Standard / Deep)

| Tier | When | Handoffs |
|------|------|----------|
| **Light** | Facts in context; trivial fix; ≤3 tool calls confident | **0** |
| **Standard** | Independent review/research; bounded question; single deliverable | **1** |
| **Deep** | Arch fork; multi-option compare; prod-critical; failed attempts | **1** (not “more handoffs”) |

### Deliverables (A)

1. `.cursor/rules/chatgpt-mcp.mdc` — tier table + anti-loop + examples
2. `.cursor/skills/chatgpt-mcp/SKILL.md` — same + “state tier before create”
3. `scenarios-agent-ux.md` — 12 cases (done)
4. `npm run test:agent-policy` — static lint only

### Deferred (P1)

- `depth` metadata on `handoff_create_task`
- Automated LLM policy eval

---

## Track B — Worker chat rotation

### Config

- `HANDOFF_MAX_TASKS_PER_CHAT` default **20** (env-wide; per-worker override **P1/defer**)
- Warn display at **N−1** (dashboard only); rotate at **N** only

### Worker state (minimal)

- Persist: `tasks_on_chat`, `chat_url` (mirror topology), `previous_chat_url`, `chat_rotated_at`
- Status: reuse **`NOT_READY`** + structured **readiness reason** enum:
  - `ROTATION_PENDING`, `ROTATION_FAILED`, `RESTART_REQUIRED`, `CONSENT_REQUIRED`, `THRESHOLD_REACHED`
- **No** persisted `ROTATING` status unless trivially free — NOT_READY + reason suffices

### Trigger

At **idle → pre-claim** under broker lock: if `tasks_on_chat >= max` → exclude from claim → start rotation subflow.

### Manual CLI

`npm run rotate-worker -- --id=w2`

- Refuses if worker busy (or sets `ROTATION_PENDING` drained after current task completes — pick one, document)
- Same subflow as auto; reason=`manual`

### Topology / concurrency

- Serialize rotation + topology file writes (file lock or existing coordination)
- Patch **one worker** in topology; re-read latest file before second concurrent rotation
- Multiple workers may need restart — batch operationally OK; correctness > parallel rotation

### Deliverables (B)

1. Schema migration + unit tests (counter, threshold, URL identity)
2. Dispatch-boundary increment (in worker dispatch success path)
3. `src/ops/rotate-worker.ts` + CLI (**before** broker auto-trigger)
4. Broker pre-claim gate + fail-closed
5. Dashboard: `tasks_on_chat / max`, readiness reason chips
6. `npm run test:rotation`
7. Live evidence: manual rotate + low-threshold auto + post-rotate burst

### Cut from 0.5.0

- Canary on rotation critical path (post-restart burst is enough)
- Auto self-restart broker inside rotation
- Per-worker max override (unless trivial)
- Age/token heuristics
- Dashboard rotation controls (CLI + docs only)

---

## Track C — Evidence & release

1. Scenario sign-off table filled
2. Live rotate + burst + failure injection notes
3. `docs/roadmap.md` §0.5.0 expanded; `docs/architecture.md` rotation section
4. Tag `v0.5.0`

---

## Implementation order (revised)

| Phase | Scope |
|-------|--------|
| **0.5-plan-v2** | This doc frozen; confirm review #2 |
| **0.5-a1** | Rule + skill + `test:agent-policy` + manual scenario run |
| **0.5-b1** | Schema + counter at dispatch + unit tests |
| **0.5-b2** | `rotate-worker` CLI (idle check, atomic topology, consent/restart UX) |
| **0.5-b3** | Broker pre-claim gate + fail-closed |
| **0.5-b4** | Dashboard capacity + readiness reasons |
| **0.5-ship** | Live evidence, docs, tag |

---

## Risk register

| Risk | Mitigation |
|------|------------|
| Rotation races in-flight task | Idle-only; exclude from claims before rotate |
| Restart corrupts budget | Counter tied to URL; persist before reset |
| Chat created but MCP not ready | CONSENT_REQUIRED; no dispatch |
| Concurrent rotations clobber topology | Serialize writes; patch single worker |
| Agent handoff spam/underuse | Scenarios + anti-loop rule |

---

## Review history

| Round | Task | Verdict |
|-------|------|---------|
| #1 | `ho_01M092T4XGHW50Z6C39ENW8454` | APPROVE_WITH_CHANGES → merged v2 |
| #2 | `ho_01M092XE84JVFPF48XXD4BXKGF` | **APPROVE** — start 0.5-a1; clarify validate vs consent (merged) |
