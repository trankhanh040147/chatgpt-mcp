# Agent UX scenarios — 0.5.0 acceptance

Manual release evidence. Each case: expected tier + handoff count (0 or 1).

| # | Input situation | Tier | Handoffs |
|---|-----------------|------|----------|
| 1 | User asks what an already-visible function does; answer explicit in code/context | Light | 0 |
| 2 | Rename/local typo or obvious one-line fix, no design ambiguity | Light | 0 |
| 3 | Explain compiler/runtime error whose cause and fix are explicit in supplied log/context | Light | 0 |
| 4 | Review bounded SQL migration for correctness/security with enough schema/diff supplied | Standard | 1 |
| 5 | Research current external best practice/version behavior not present locally | Standard | 1 |
| 6 | Independent code review of a focused diff before shipping | Standard | 1 |
| 7 | Debug after local investigation leaves two plausible root causes; independent diagnosis useful | Standard | 1 |
| 8 | Architecture fork between two persistence/concurrency designs with material trade-offs | Deep | 1 |
| 9 | Production-critical auth/security design review before rollout | Deep | 1 |
| 10 | Multiple attempted fixes failed; next action requires reassessing assumptions | Deep | 1 |
| 11 | Deep handoff result incomplete/ambiguous for same architecture decision | Deep | **1 total** — continue locally or ask user; no immediate re-handoff |
| 12 | Task has several subquestions supporting one bounded release decision | Standard/Deep | **1 total** bundled handoff, not one per subquestion |

**Policy assertion:** tier is not recursive delegation. Deep = use the single external slot carefully, not more handoffs.

## Release sign-off

Operator ship 2026-08-18: policy lint (`test:agent-policy` 51/51) + live rotate/burst. Cases 1–12 match the frozen table above.

| # | Pass? | Notes | Date |
|---|-------|-------|------|
| 1 | yes | Light / visible function | 2026-08-18 |
| 2 | yes | Light / rename-typo | 2026-08-18 |
| 3 | yes | Light / explicit error | 2026-08-18 |
| 4 | yes | Standard / bounded review | 2026-08-18 |
| 5 | yes | Standard / external research | 2026-08-18 |
| 6 | yes | Standard / focused diff review | 2026-08-18 |
| 7 | yes | Standard / two root causes | 2026-08-18 |
| 8 | yes | Deep / architecture fork | 2026-08-18 |
| 9 | yes | Deep / prod-critical auth | 2026-08-18 |
| 10 | yes | Deep / failed attempts | 2026-08-18 |
| 11 | yes | Anti-loop: 1 total | 2026-08-18 |
| 12 | yes | Bundle subquestions: 1 total | 2026-08-18 |
