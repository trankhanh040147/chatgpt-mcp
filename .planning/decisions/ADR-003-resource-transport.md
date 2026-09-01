# ADR-003 — Resource transport selection

**Status:** Accepted  
**Date:** 2026-08-29 (updated after review)

## Decision

**Agent chooses context; runtime chooses transport.**

| Transport | Role in v0.6 |
|-----------|----------------|
| `NativeAttachmentTransport` | **Production ship bar** — guaranteed delivery as model input |
| `McpResourceTransport` (tool façade) | Shipped; **not** production substitute for attach |
| `ContextPackTransport` | Post-0.6 experiment |
| ZIP | Experiment only |

**No silent fallback:** if native attach fails → fail closed. Do **not** auto-route to MCP read.

Rationale: v0.6 goal is *runtime guarantees selected resources are delivered*, not merely that ChatGPT *can* pull them via tool. Native attachment makes files direct turn input; MCP lazy read is pull-based and model-dependent.

Automatic routing deferred until post-0.6 benchmark evidence.

## Consequences

- E2E must prove native path with nonce — not MCP read (see active spec).
- `handoff_read_file` stays for Codex spike / experiments; web worker ship bar = attach.

## Open questions (post-0.6)

- MCP Resource primitive (`ResourceLink`) reliability on ChatGPT host
- Context-pack vs N native chips for many small files
