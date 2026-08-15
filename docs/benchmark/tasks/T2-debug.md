# T2 — Debug stuck QUEUED / not READY

**Type:** debug · **Expect B helpful:** yes

## Fixture

Synthetic incident (do not break the live worker if others are using it). Give the agent this symptom pack only:

```text
Symptoms:
- handoff_create_task returns a task id
- handoff_get_task_status stays QUEUED for >2 minutes
- curl http://127.0.0.1:8787/health → {"ok":true} sometimes
- ChatGPT worker chat is open in some Chrome window

Constraints:
- Propose a differential diagnosis and an ordered fix checklist.
- Prefer commands that exist in this repo (npm run check, CDP scripts).
```

## Operator prompt

```text
Using only the symptom pack in docs/benchmark/tasks/T2-debug.md, diagnose why
handoffs stay QUEUED and give an ordered fix checklist with commands from this repo.
```

## HANDOFF_POINT (Arm B only)

Once, after the agent drafts a first diagnosis:

```text
type: debugging
prompt: Critique this QUEUED-handoff diagnosis for chatgpt-mcp. What commonly missed causes (DB path mismatch, worker_state, CDP profile, remote MCP) should be on the checklist? Return a tightened ordered checklist.
```

## Done when

Checklist would catch: wrong `HANDOFF_DB_PATH`, worker not READY, CDP on wrong profile, remote MCP down, second worker instance.
