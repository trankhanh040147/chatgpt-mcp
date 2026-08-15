# T3 — Code review of submit_result path

**Type:** review · **Expect B helpful:** yes

## Fixture

Focus files (agent may read neighbors):

- `src/tasks/task.service.ts` (submit / save result)
- `src/mcp/tools/index.ts` (tool registration / annotations)

## Operator prompt

```text
Review the ChatGPT-facing submit_result / save-result path for correctness and
idempotency. List must-fix defects (if any), then residual risks. Cite functions.
Do not propose a rewrite of the product.
```

## HANDOFF_POINT (Arm B only)

After local review notes exist:

```text
type: code_review
prompt: Independent review of chatgpt-mcp submit_result idempotency and conflict handling. Prefer actionable defects over style. Cite symbols.
```

## Done when

Either concrete defects with file/symbol cites, or an explicit “no must-fix” with residual risks (races, double submit, FAILED overwrite).
