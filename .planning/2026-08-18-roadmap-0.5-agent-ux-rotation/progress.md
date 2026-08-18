# Progress — 0.5.0 agent UX + rotation

## Status: **planning / review loop**

| Phase | Status | Notes |
|-------|--------|-------|
| 0.5-plan draft | done | v1 |
| ChatGPT plan review #1 | done | APPROVE_WITH_CHANGES → v2 merged |
| ChatGPT plan review #2 | done | **APPROVE** — start 0.5-a1 |
| Plan stable | done | |
| 0.5-a1 skill/rule | done | test:agent-policy 51/51 after wording harden |
| 0.5-a1 code review #3 | done | APPROVE_WITH_CHANGES → wording/lint applied |
| 0.5-a1 confirm review | done | **APPROVE** |
| 0.5-b1 schema + counter | done | test:rotation |
| 0.5-b2 rotate-worker CLI | done | idle-only; topology lock; CONSENT/RESTART |
| 0.5-b3 broker pre-claim gate | done | claimNextQueued + THRESHOLD_REACHED |
| 0.5-b4 dashboard capacity | done | chip + indicators |
| 0.5-b code review #5 | done | APPROVE_WITH_CHANGES → reservation CAS |
| 0.5-b confirm review | done | **APPROVE** ho_01M094BSB5W014VCK8EZV83J0Q |
| 0.5 live rotate + burst | done | w3 rotated; burst --n=3 PASS |
