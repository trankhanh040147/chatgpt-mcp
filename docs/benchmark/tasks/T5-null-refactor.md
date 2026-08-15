# T5 — Null control: rename a local variable

**Type:** null refactor · **Expect B helpful:** neutral / maybe worse

## Fixture

In `scripts/check.ts`, rename a **single local** variable in `main` to a clearer name without changing behavior. No new deps, no refactors elsewhere.

## Operator prompt

```text
In scripts/check.ts only, rename one local variable inside main() to a clearer
name. Do not change behavior, logging text, or other files. Show the diff.
```

## HANDOFF_POINT (Arm B only)

**Forced** one handoff even though it should not help much:

```text
type: code_review
prompt: Should we rename a local variable in scripts/check.ts for clarity? Give a yes/no and a suggested name only.
```

Then apply or reject; still only touch `scripts/check.ts` if applying.

## Done when

Minimal correct diff **or** explicit no-op with rationale. Used to detect Arm B overhead / noise.
