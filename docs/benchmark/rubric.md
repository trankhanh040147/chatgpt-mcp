# Rubric — bench-v1

Score each run **0–100**. Prefer evidence in the artifact over confidence language.

## Dimensions (sum = 100)

| Pts | Dimension | 0 | Mid | Max |
|-----|-----------|---|-----|-----|
| 30 | **Correctness** | Wrong or unsafe | Mostly right, gaps | Accurate vs repo/docs/facts |
| 25 | **Actionability** | Vague advice | Partial next steps | Concrete, ordered, implementable |
| 20 | **Coverage** | Misses main ask | Hits primary ask | Hits ask + important edges |
| 15 | **Evidence** | No citations/paths | Some pointers | File paths, commands, or sources |
| 10 | **Economy** | Rambling / filler | OK length | Tight; little noise |

## Penalties (subtract, floor 0)

| − | Condition |
|---|-----------|
| 15 | Invented APIs, files, or benchmark numbers |
| 10 | Ignores stated constraints (e.g. second handoff on Arm B) |
| 10 | Arm B used DOM scrape narrative instead of MCP result |
| 5 | Major markdown/structure dump that obscures the answer |

## Arm integrity checks (fail the run, do not score)

- **A:** Any `handoff_*` tool call → void run, redo.
- **B:** Zero handoffs or ≥2 handoffs → void run, redo.
- **B:** Handoff not at `HANDOFF_POINT` → void unless task allows “asap once”.

## Time & edits (reported, not in the 0–100)

- **Wall time:** start of operator prompt → agent declares done / stops.
- **Human edits:** number of non-trivial fix-ups needed before you’d merge or trust the answer.
