# Worker chat rotation

**0.5.0.** Long-lived ChatGPT worker chats accumulate `TASK_ID` dispatches. When the count hits `HANDOFF_MAX_TASKS_PER_CHAT` (default **20**), the worker must not claim another task until a new chat is wired.

Consent model A still applies: no auto-login / auto-approve MCP writes.

## Measure → threshold → rotate

1. **Measure** — `tasks_on_chat` increments once per successful dispatch (message sent), including later FAILED/TIMED_OUT. Bound to `{worker_id, chat_url}`; survives broker restart.
2. **Threshold** — at `== N` the worker is excluded from claims (`THRESHOLD_REACHED`). Dashboard shows `n/N` (warn at N−1).
3. **Rotate** — idle-only. Reserve (`ROTATION_PENDING`) → create Chat+Cursor chat → commit new URL then reset counter → `CONSENT_REQUIRED` and/or `RESTART_REQUIRED`.
4. **Restart** — operator restarts the broker (`gptmcp restart` or `make dashboard-up`). Rotation does **not** self-restart.

## Operator recovery

```bash
# Manual rotate (refuses if the worker has an in-flight task)
gptmcp worker rotate --id=w2
# legacy: make rotate-worker ARGS='--id=w2'

# After CONSENT_REQUIRED: approve write tools in the new ChatGPT chat, then:
gptmcp restart               # restart broker so it binds the new /c/… URL
gptmcp status                # worker READY; budget 0/N
```

| Readiness | Meaning | Action |
|-----------|---------|--------|
| `THRESHOLD_REACHED` | Chat at max; no new claims | Rotate |
| `ROTATION_PENDING` | Reservation held; create in progress | Wait or abort (unit path); do not claim |
| `CONSENT_REQUIRED` | New URL committed; MCP writes not approved | Approve in the new chat |
| `RESTART_REQUIRED` | Topology updated; process still on old bind | Restart broker |
| `ROTATION_FAILED` | Fail-closed | Inspect `error`; keep old URL if pre-commit |

**Crash rule:** pre-commit failure keeps the old URL + counter. Post-commit (file written) keeps the new URL; worker stays NOT_READY until consent/restart.

Tests: `npm run test:rotation`, `npm run test:agent-policy`. Dashboard chips: [dashboard.md](dashboard.md).
