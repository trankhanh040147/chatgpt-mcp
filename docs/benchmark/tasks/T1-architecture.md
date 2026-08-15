# T1 — Architecture overview

**Type:** architecture · **Expect B helpful:** yes

## Fixture

Work in the `chatgpt-mcp` repo at the pinned benchmark commit. Read-only unless the arm’s agent chooses to open files.

## Operator prompt (identical for A and B)

```text
Explain how chatgpt-mcp moves a task from Cursor to ChatGPT and back.
Cover: SQLite role, what CDP sends vs what MCP carries, and the trust boundary
(local profile, tunnel, what not to expose). Use concrete file/module names.
Keep it under ~400 words plus a tiny bullet list of failure modes.
```

## HANDOFF_POINT (Arm B only)

After the agent’s first pass at locating architecture docs/code, create **one** handoff:

```text
type: architecture_review
prompt: Independent review of how chatgpt-mcp handoff works (CDP task-id only vs MCP payload). List misconceptions a new user might have; correct them using the repo.
```

Then merge the MCP result into the final answer (still ≤~400 words + failure bullets).

## Done when

A reader who never saw the repo understands the loop and the “don’t tunnel :8787” rule.
