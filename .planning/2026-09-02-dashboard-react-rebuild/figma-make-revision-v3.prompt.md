# Figma Make revision prompt — v3 (final design gaps)

Paste below into the **existing** Make file.  
**Do not change visual language** — only add/fix the gaps from [design-review-v2.md](./design-review-v2.md).

---

## Context

Reviews #1 and #2 passed: light theme, w1/w2/w3, control plane strip, causal ladder, capacity semantics, overflow menu, confirm modals, add-worker waiting, API unreachable, Diagnostics tab.

This v3 pass closes **6 remaining design gaps** before React port.

---

## ADD 1 — Dispatch-readiness line

Between **control plane strip** and **contextual alert**, add one sentence answering: *Can I send a handoff right now?*

Default (current mock):

```
2 of 3 workers dispatch-ready
```

Use muted `#9999A8` or `#6E6E80` — secondary to strip, primary to page content.

Variants to show as separate notes or frames:

- `3 of 3 workers dispatch-ready` (all OK)
- `0 workers dispatch-ready · Add a worker` (setup)
- `Handoffs blocked — broker unreachable` (broker offline — can replace separate banner OR sit above it)

**Do not** repeat MCP approval text here — counts/status only.

---

## FIX 2 — Dedupe MCP approval on Overview

When inline alert shows `w3 needs MCP approval`:

- **Alert:** keep Open ChatGPT + Continue
- **w3 card:** show Action required + one-line note — **remove Continue button from card**
- **w3 drawer:** keep full action box (drill-down is OK)

Add one **all-healthy frame**: w1/w2/w3 all Ready, **no alert**, dispatch line `3 of 3 workers dispatch-ready`.

---

## ADD 3 — Fail task in task drawer

For tasks in **Processing**, **Dispatching**, or **Waiting approval**, add drawer footer:

```
[Fail task…]    (red/destructive ghost, left or right)
```

Opens confirm modal:

```
Fail task ho_8f2…91c?

The task will be marked as failed and the worker slot will be released.
The handoff result will not be returned to the caller.

[Cancel]  [Fail task]
```

Timed out / failed tasks: show error block only (already exists) — no Fail button.

---

## ADD 4 — System recover entry

AppBar right `•••` overflow (header level, not worker card):

```
Recover workers…
View Diagnostics
```

**Recover workers** opens modal:

```
Recover workers?

2 workers will be reset (stale heartbeat / orphan task).
Queued tasks may be requeued.

Workers affected: w1, w2

[Cancel]  [Recover workers]
```

This is **system-level**, not the same as per-worker Recreate chat.

---

## ADD 5 — Scenario frames (one each, same visual system)

Keep existing degraded Overview; **add** these variants:

### A — Broker offline

- Strip still `● OK` (status API alive)
- Dispatch line: `Handoffs blocked — broker unreachable`
- Red/pale banner: Broker control plane unreachable + **Start broker**
- w1 drawer ladder: ✕ Broker, ? downstream

### B — STALE data

- Strip: `● STALE · Last tick 42s ago` (amber dot)
- **No separate alert** for staleness
- Rest of page may show last-known data with subtle muted treatment (optional)

### C — SESSION_LOST (w2)

- Dispatch: `1 of 3 workers dispatch-ready`
- One alert: `w2 — ChatGPT session lost` + **Recreate chat** + Open ChatGPT
- w2 card: Action required, no duplicate primary button if alert shows

### D — chatAccessDenied (w1)

- One alert: `w1 — Chat URL not accessible in CDP Chrome` + **Assign URL**
- Explain: dedicated Chrome profile cannot open this conversation

### E — Worker starting (w4)

- w4 card: `Starting` + progress line: `Creating ChatGPT chat… · Step 2 of 4 · Binding browser tab`
- Blue pulse dot — not warning styling

---

## ADD 6 — Task drawer redacted preview

Replace static privacy line with two states:

**Default (content off):**

```
Task content is hidden for privacy.
```

**Redacted mode on:**

```
Task content is hidden for privacy.
[Load redacted preview]

Redaction is best-effort — may not remove all sensitive text.
```

Optional collapsed preview block after load (lorem / placeholder redacted text).

---

## Deliverables (v3)

- [ ] Dispatch-readiness line on Overview
- [ ] All-healthy Overview (no alert)
- [ ] w3 card without Continue when alert shown
- [ ] Task drawer Fail task footer + modal
- [ ] Header Recover workers modal
- [ ] Frames: broker offline, STALE, SESSION_LOST, chatAccessDenied, Starting worker
- [ ] Task drawer redacted load button state

Do not regenerate mobile. Keep Instrument Sans, JetBrains Mono, Tailwind v4, 1440px desktop.

**Review question:** Can a developer answer “can I handoff?”, “what’s wrong?”, and “what do I click?” in 10 seconds on each frame?
