# ADR-009 — Runtime CDP ownership (B1)

**Status:** Accepted  
**Date:** 2026-08-30  
**Relates:** [ADR-008](./ADR-008-worker-ops-dashboard.md), v0.6 Worker Control Plane

## Context

Production stack runs **separate processes**: `status-api` (:8787), `browser-broker`, `remote-mcp` (:8790). Multiple code paths today call `chromium.connectOverCDP()`:

- `browser/broker.ts` (A1-S owner)
- `browser/create-chat.ts` (`rotate-worker`, `create-worker` CLI)
- `browser/chatgpt.ts` (standalone workers, create-worker canary)

Playwright documents lower fidelity for CDP attach vs native Playwright protocol. Multiple CDP clients increase lifecycle races (orphan tabs, stale bindings, dual ownership).

v0.6 Worker Ops adds URL mutation, create chat, and verification while the broker is running.

## Decision — B1 Runtime CDP ownership

```text
While browser-broker is running, it is the sole owner of
production worker browser mutations.

Worker Ops MUST use Broker Control HTTP (:8788 loopback).

Legacy standalone CLI paths MAY connectOverCDP directly only when
broker ownership is absent (no broker process / explicit offline tooling).
```

### Broker Control Plane

- Bind **127.0.0.1** only (never `0.0.0.0`).
- `HANDOFF_BROKER_OPS_TOKEN` required when broker ops server enabled; startup fails if empty in production stack.
- Endpoints: status, probe, bind, unbind, create-chat (see impl plan).

### Follow-up (post v0.6.0)

Eliminate direct CDP from `create-worker` / `rotate-worker` when broker is up (CLI calls broker HTTP or warns).

## Fleet invariant (G3)

```text
Registry file invalid (parse / schema) → broker startup MAY fail.

Individual worker unbindable at runtime → worker BLOCKED/UNBOUND;
broker continues serving other workers.
```

Configuration-level corruption fails fast; worker-level runtime failure must not take down the fleet.

## Consequences

- New module `broker-control.ts` in broker process.
- status-api never imports Playwright for Worker Ops mutations.
- ADR-008 dashboard mutations orchestrate via `enqueueOperation` + reconciler, not direct CDP.

## Alternatives rejected

- **status-api connects CDP for ops** — dual owner with broker.
- **Immediate repo-wide ban on all connectOverCDP** — blocks CLI migration in same PR; scoped runtime rule instead.
