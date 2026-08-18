# Findings — 0.5.0 agent UX + rotation

## 2026-08-18 — Baseline

- **0.4 shipped:** dashboard 0.1–0.3 + usage; recover/selective reset.
- **Workers:** w1/w2/w3 on Chat + Cursor (not Work/Codex); burst `--n=3` COMPLETED.
- **create-worker:** `ensureChatSurface`, `attachCursorPlugin`, canary releases instance.
- **submitTaskId:** false-ack fix (`user` role only + composer must clear).
- **Dashboard:** `completedLast24h` per worker; hint “No rotation max configured — 0.5 owns budget”.
- **No rotation code** in `src/` yet — greenfield.
- **Agent policy:** single-tier handoff rule in `.cursor/rules/chatgpt-mcp.mdc`; skill lists when/when-not only.

## Review rounds

### #1 — `ho_01M092T4XGHW50Z6C39ENW8454` (2026-08-18)

**Verdict:** APPROVE_WITH_CHANGES

**Key merges into plan v2:**

- Counter = **dispatch boundary**, not COMPLETED; includes FAILED/TIMED_OUT after send
- Counter tied to `{worker_id, chat_url}`; persist across restart
- Rotation **idle-only**; single pre-claim gate under broker lock
- **NOT_READY + readiness reason** instead of ROTATING status
- **RESTART_REQUIRED** — operator/supervisor restarts broker; no self-restart in rotation
- Crash-safe ordering: commit URL before counter reset
- Manual CLI refuses busy worker
- **CONSENT_REQUIRED** fail-closed
- Default max **20**; warn at N−1 display only; rotate at N
- **depth** metadata + per-worker override → P1
- Canary on rotation path → cut; post-restart burst sufficient
- 12 scenarios adopted → `scenarios-agent-ux.md`

### #2 — `ho_01M092XE84JVFPF48XXD4BXKGF` (2026-08-18)

**Verdict:** APPROVE — start 0.5-a1.

**Clarification merged:** pre-commit validate = chat created + URL valid; consent may follow as CONSENT_REQUIRED after commit.

## 0.5-a1 implementation (2026-08-18)

- Updated `.cursor/rules/chatgpt-mcp.mdc` — Light/Standard/Deep + anti-loop + examples
- Updated `.cursor/skills/chatgpt-mcp/SKILL.md`
- Added `scripts/test-agent-policy.ts` + `npm run test:agent-policy`

### #4 — `ho_01M0935G1MHNJQ23DBZJZT2T5R` (2026-08-18)

**Verdict:** APPROVE — 0.5-a1 complete; start 0.5-b1.

## 0.5-b1 implementation (2026-08-18)

- Schema v5: `tasks_on_chat`, `tasks_on_chat_url`, `previous_worker_url`, `chat_rotated_at`, `readiness_reason`, `worker_chat_dispatch`
- `src/workers/chat-budget.ts` — parseMaxTasksPerChat, threshold helpers
- `TaskRepository.recordChatDispatch` — idempotent at dispatch boundary
- URL change on register resets counter
- `BrowserWorker` records budget after successful `submitTaskId`
- `/workers` exposes `tasksOnChat`, `maxTasksPerChat`, budget warn/exhausted
- `HANDOFF_MAX_TASKS_PER_CHAT=20` in config + `.env.example`
- `npm run test:rotation` — 13/13 pass; leases regression green

## 0.5-b2/b3/b4 (2026-08-18)

- `commitRotatedWorker` + `npm run rotate-worker -- --id=wN` (idle-only, no broker self-restart)
- Topology file lock; URL commit then DB counter reset
- `claimNextQueued` refuses when readiness_reason set or `tasks_on_chat >= max`
- Nth dispatch sets `THRESHOLD_REACHED`
- Dashboard chat budget `n/max` + rotation indicators
- `test:rotation` 23/23; leases/ops/usage/create-worker/agent-policy green

### #5 — `ho_01M0944Y6RNSBT53QWB8YK22XE` (2026-08-18)

**Verdict:** APPROVE_WITH_CHANGES — idle-check vs claim race is P0.

**Applied:** `beginRotationReservation` under IMMEDIATE lock → `ROTATION_PENDING` before chat create; claim blocked; concurrent reserve fails; abort restores; CONSENT_REQUIRED survives register. `test:rotation` 31/31.

### #6 — `ho_01M094BSB5W014VCK8EZV83J0Q` (2026-08-18)

**Verdict:** APPROVE — ready for live rotate.

## Live evidence (2026-08-18)

- `npm run rotate-worker -- --id=w3 --yes --assume-consent`
- New chat `https://chatgpt.com/c/6a83a817-8250-83ec-a21e-9d9311cf8372`
- Broker restart cleared `RESTART_REQUIRED`; w3 URL bound
- `e2e-burst --n=3` PASS (~92s): owners w3/w2/w1 all COMPLETED
- Log: `logs/e2e/burst-3-2026-08-18T00-34-19-139Z.json`



