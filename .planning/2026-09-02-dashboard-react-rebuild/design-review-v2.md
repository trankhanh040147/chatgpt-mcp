# Design review #2 — post semantics pass (2026-09-03)

**Make file:** [Create Design from Spec](https://www.figma.com/make/GdV7zzx4CjYqKrUEp24O29/Create-Design-from-Spec?t=vAndgFVMumHk4Q4m-1)  
**Compared to:** [design-review.md](./design-review.md) · [figma-make-revision.prompt.md](./figma-make-revision.prompt.md) v2  
**Backend reference:** `worker-health.ts`, vanilla `app.js`, status-api routes

## Verdict

| Score | Meaning |
|-------|---------|
| **Visual / IA** | **9/10** — light theme, tabs, hierarchy, drawers — keep |
| **State semantics** | **8/10** — causal ladder, capacity, strip — major pass |
| **API / ops parity** | **6.5/10** — several operator flows still missing frames |
| **Overall** | **Conditional sign-off** — one more **small Make pass** (v3 prompt) OR accept gaps as engineering-only at port time |

**Recommendation:** Run [figma-make-revision-v3.prompt.md](./figma-make-revision-v3.prompt.md) (~30 min in Make) for the **6 design-only gaps** below. Do **not** redo visual language.

---

## 10-second operator test

| Question | Current design | Pass? |
|----------|----------------|-------|
| Can I send a handoff now? | Strip shows `● OK` + lease reaper — **no dispatch-ready sentence** | **Partial** |
| What is happening? | Active handoff + w2 Working card | **Yes** |
| What is unhealthy? | Alert for w3 MCP | **Yes** |
| What should I do next? | Alert CTAs + w3 Continue on card | **Yes** (but redundant) |

**Fix:** Add one dispatch-readiness line under control plane strip, e.g.  
`2 of 3 workers dispatch-ready · Broker connected`  
(or `Handoffs blocked — broker unreachable` when applicable).  
Vanilla headline did this; strip alone is insufficient for Q1.

---

## Checklist vs v2 deliverables

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| 1 | Control plane strip (primary/secondary) | ✅ | `ControlPlaneStrip` — OK / STALE, tooltip, counters |
| 2 | Causal ladder + UNKNOWN | ✅ | `CheckLadder` + broker-down summary |
| 3 | Worker ids w1/w2/w3 | ✅ | |
| 4 | Operator vocabulary on cards | ✅ | No READY/SESSION_LOST on card |
| 5 | Capacity calm at 16 | ✅ | Text only at 16; amber bar at 18+ |
| 6 | Single contextual alert | ⚠️ | Alert OK but **card duplicates** w3 action |
| 7 | API unreachable full page | ✅ | Demo toggle; correct copy + commands |
| 8 | Broker offline banner | ⚠️ | `AlertBanner(brokerOffline)` in code — **no visible frame** |
| 9 | STALE strip variant | ⚠️ | `stale` prop — **no visible frame** |
| 10 | Add worker waiting step | ✅ | Step 3: no Next, timer, doctor |
| 11 | Destructive confirm modals | ✅ | Recreate + Remove with consequence copy |
| 12 | Overflow menu grouped | ✅ | Context-sensitive Continue |
| 13 | Diagnostics human-first | ✅ | JSON collapsed last |
| 14 | Empty workers | ✅ | |
| 15 | Fail task UI | ❌ | Modal exists; **no drawer trigger** |
| 16 | System recover UI | ❌ | No entry; modal is per-worker only |
| 17 | SESSION_LOST scenario | ❌ | No frame |
| 18 | chatAccessDenied scenario | ❌ | No Assign URL alert |
| 19 | Worker Starting / async op | ❌ | No in-progress card banner |
| 20 | Task redacted load | ❌ | Static privacy text only |
| 21 | All-OK (no alert) frame | ❌ | Only degraded mock |
| 22 | Real commands / ports | ✅ | 8787 / 18788 |

---

## What improved since review #1

- Worker ids `w1`–`w3` (was A1–A3)
- Hierarchical control plane strip
- `CheckLadder` with downstream `?` when broker fails
- Grouped overflow menu
- Confirm modals with blast-radius preview
- Add-worker MCP waiting state
- API unreachable page
- Complete Diagnostics tab structure
- Capacity semantics match product (6/20 quiet, 16 approaching text)

---

## Gap analysis — design pass recommended (v3)

### G1 — Dispatch-readiness line (operator Q1)

**Problem:** Control plane strip answers “is API alive?” not “can I handoff?”

**Design:** One line between strip and alert (when workers exist):

```
2 of 3 workers dispatch-ready
```

Variants:

- `0 of 1 workers dispatch-ready · Add a worker`
- `Handoffs blocked — broker unreachable` (when broker offline — may replace separate banner or complement it)
- `All workers dispatch-ready` (when N/N)

Do **not** duplicate w3 MCP copy here — counts only.

### G2 — Dedupe w3 incident on Overview

**Problem:** Same MCP approval in alert + card Continue + drawer amber box.

**Rule for Make + port:**

| Surface | w3 MCP approval |
|---------|-----------------|
| Inline alert | Full message + Open ChatGPT + Continue |
| Worker card | Status + short note — **no Continue button** when alert visible |
| Worker drawer | Full actions OK (drill-down) |

Add **all-OK frame** (3 ready workers, no alert) to prove quiet state.

### G3 — Fail task (active processing)

**Problem:** Vanilla allows fail from drawer for stuck PROCESSING tasks.

**Design:** Task drawer footer when status is Processing / Dispatching / Waiting approval:

```
[Fail task…]   (destructive ghost)
```

Opens existing `fail_task` confirm modal. Show on timed_out/failed tasks as read-only error (already present).

### G4 — System recover

**Problem:** `POST /ops/recover/preview` returns blast radius across workers — not per-worker.

**Design:** AppBar `•••` menu or control-plane overflow:

```
Recover workers…
```

Modal:

```
Recover workers?

2 workers will be reset (stale heartbeat / orphan task).
Queued tasks may be requeued.

[Cancel]  [Recover workers]
```

Separate from per-worker “Recreate chat”.

### G5 — Missing operator scenarios (one frame each)

| Scenario | Inline alert primary action |
|----------|----------------------------|
| **SESSION_LOST** (w2) | `Log into ChatGPT in CDP Chrome` + Recreate chat |
| **chatAccessDenied** (w1) | `Assign URL` — wrong Chrome account |
| **Broker offline** | Banner only (already coded) — **show frame** |
| **STALE strip** | Strip `● STALE 42s ago` — **show frame**, no extra alert |
| **Starting worker** | Card: `Starting` + `Creating ChatGPT chat… step 2/4` |

### G6 — Task drawer redacted mode

When content enabled, replace static line with:

```
Task content is hidden for privacy.
[Load redacted preview]

Redaction is best-effort — may not remove all sensitive text.
```

---

## Gap analysis — engineering at port (no Figma required)

| Item | Notes |
|------|-------|
| `index.css` body `#09090d` | Set `#F6F6F8` in port |
| Version `v0.8.3` | `{packageVersion}` at runtime |
| `CheckLadder` data source | Map `GET /workers/health` conditions + `suppressDownstream()` |
| `deriveOperatorPresentation()` | Map to card labels — BUSY → Working, etc. |
| Poll interval ~5s | Make mock 3s display optional |
| CSRF / confirm | Wire all `POST /ops/*` |
| Demo toggles | Remove before cutover |
| Bot avatars | Optional strip for text-first |

### Causal suppression (must implement in code)

Backend returns independent conditions; UI must apply:

```text
if BROKER is FALSE or UNKNOWN → BINDING, URL, SESSION, MCP_* display UNKNOWN
if PROCESS is FALSE → downstream UNKNOWN (except PROCESS)
```

Make `CheckLadder` demonstrates broker case only — port must generalize per `worker-health.ts` condition order.

---

## Backend → UI mapping reference

| API / logic | Make mock | Port target |
|-------------|-----------|-------------|
| `OperatorState` | `WorkerStatus` enum | Map via `/workers/health` row |
| `operatorDetail` | `actionNote` / card copy | Use server string |
| `conditions[]` | `brokerConnected`, booleans | Ladder from API |
| `chatAccessDenied` | — | Alert + Assign URL |
| `activeOperation` | — | Card `Starting` + step text |
| `tasks_on_chat / max` | `chatBudget` | Same |
| Taxonomy DOWN/SETUP/DEGRADED/OK | — | Dispatch line + alert gating |

---

## Sign-off decision tree

```
Need pixel-perfect all states in Figma?
  → Yes: paste v3 prompt, review once more
  → No: sign-off visual + semantics, engineering fills G3–G6 at port

Ready to scaffold React?
  → After v3 OR explicit accept of engineering-only gaps
  → Vanilla stays at /dashboard/ until parity tests pass
```

---

## Next steps

1. **Optional:** [figma-make-revision-v3.prompt.md](./figma-make-revision-v3.prompt.md) in Make (~6 frames)
2. **You:** Sign-off or list deltas
3. **Engineering:** Scaffold `src/dashboard/ui/` on `feat/dashboard-react`
