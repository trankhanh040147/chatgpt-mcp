# Findings — dashboard 0.2 audit (`ho_01M04PJWX91DS0C3R07W3WBEPF`)

## Verdict (accepted)

- **0.1 correctly closed.** Operator feature asks belong in **0.2**, not reopen 0.1.
- **0.2 should stay read-only.** Move recover/clear to **0.3+**.
- Prefer **real signals** over inventing statuses/KPIs.

## Operator asks → decision

| Ask | Decision |
|-----|----------|
| completedAt / duration | **P0** — precise phase timings |
| task input / output | **P0** — on-demand **redacted** only; never list poll |
| progress bar to max tasks | **Count yes, bar/max no** until package 0.5 |
| overload / hallucinate status | **Do not invent**; use indicators / real error codes |
| link to ChatGPT worker | **P0** — topology URL, allowlisted |

## Critical notes (ours)

- Agree: no `HALLUCINATE` status without a validator event.
- Agree: content scrubbing must be server-side; default off.
- Agree: `innerHTML` with task text is a footgun — prefer safe DOM (0.1 currently uses escaped HTML strings; tighten in 0.2 drawer work).
- Package **0.4.0** tag can still land on 0.1-only if we choose; 0.2 can be 0.4.x or same milestone — product call at tag time.
