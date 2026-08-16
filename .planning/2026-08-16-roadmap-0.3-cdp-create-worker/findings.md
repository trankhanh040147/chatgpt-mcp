# Findings — 0.3.0 CDP architecture

## Decision chain

| Review | ID | Outcome |
|--------|-----|---------|
| First | `ho_01M042EE…` | A1(i) exclusive broker + concurrent page actors (**CONDITIONAL**) |
| Second | `ho_01M042QR…` | Refine to **A1-S**: same broker, but **global mutex only around irreversible UI writes** |

## Locked P0 recommendation: **A1-S**

**One headed Chrome + one exclusive Node browser-broker + N chat tabs/pages**, with a **narrow global UI-write mutex**:

```
validate page → renew → dispatch/nudge CAS → revalidate → fill/type → send → confirm → release mutex
```

**Concurrent outside the mutex:** claim, lease heartbeat, wait for ChatGPT, MCP fetch/submit, result poll.

**Rationale (agreed):** local CDP only sends short `TASK_ID`; expensive work is remote MCP. Fully concurrent composer mutation has little upside and large risk. Serializing a few seconds of type/send preserves multi-worker PROCESSING overlap.

### Reject / defer

| Option | Stance |
|--------|--------|
| A1(ii) N Node × one CDP | **NOT FEASIBLE** |
| Fully concurrent A1(i) writes | Defer until after A1-S proven |
| N headless Chromes (1 CDP headless/worker) | **CONDITIONAL**, **not** 0.3 P0 — login bootstrap, challenges, passkeys, MCP approve UX, profile lock |
| A2 on-demand CDP | Defer (idle RAM only) |
| Chrome extension / raw CDP / one multiplexed chat | Reject for P0 |
| N headed (0.2 / A3) | **Supported fallback** if spike fails |

### Critical evaluation (Cursor)

Second opinion improves on the first: TASK_ID-only dispatch is the key product fact. A1-S is the right MVP. Kill criteria are strong (wrong chat, mutex covering wait/approval, no PROCESSING overlap, &lt;~25% memory win → stay on N headed).

Headless-per-worker assessment is fair: protocol-possible, product-fragile; keep experimental.

## Spike (A1-S)

1. Exclusive two-page broker + exact `/c/<id>` bind + generation ids  
2. Narrow UI-write mutex (not covering wait/approval/lease)  
3. ≥50 paired canaries; prove PROCESSING overlap + no cross-talk  
4. Inject reload/close/CDP drop/broker restart around fences  
5. Measure memory (proportional/unique, not naïve RSS sum) vs 2 headed; target ≥~25% reduction  

## Next

Implement A1-S spike harness; keep N-headed as fallback topology.
