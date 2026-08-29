# ADR-003 — Resource transport selection

**Status:** Proposed (pending benchmark)  
**Date:** 2026-08-29

## Decision (proposed)

**Agent chooses context; runtime chooses transport.** Transports are adapters over the same immutable resource manifest:

- `NativeAttachmentTransport` — **initial production** for ChatGPT web worker
- `McpResourceTransport` — lazy read (tool façade shipped; MCP Resource primitive experimental)
- `ContextPackTransport` — benchmark candidate
- ZIP — benchmark only; not default abstraction

Automatic routing deferred until experiment matrix has evidence.

## Context

Research compared native attach, context-pack, MCP lazy, MCP embedded, and ZIP. No production auto-policy until probes complete.

## Consequences

- v0.6 ship bar = resource core + **native attach** E2E
- MCP `handoff_read_file` remains available; not required for web worker ship bar
- Experiments live in `.planning/experiments/` until promoted here

## Open questions

- Does ChatGPT consume MCP `ResourceLink` / `EmbeddedResource` reliably?
- Context-pack vs N native chips for 10×20KB code files?
