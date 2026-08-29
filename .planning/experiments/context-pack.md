# Experiment — Context-pack transport

**Status:** SPIKE · **Lifecycle:** IDEA  
**Parent:** [0.6 Handoff Resources](../active/0.6-handoff-resources.md)

## Question

For 3–20 small text/code files, does a single native attachment `handoff-context.md` outperform individual native attachments or MCP lazy read?

## Format (candidate)

```markdown
# HANDOFF CONTEXT
task: ho_…

## src/auth/session.ts
<file contents>

## src/auth/token.ts
<file contents>
```

## Advantages (predicted)

- One native attachment; paths preserved; immediately model-readable; no archive extraction

## Disadvantages

- No lazy access; full pack transferred up front
- Token duplication if model re-reads via MCP

## Measure

Same matrix as [mcp-resource-transfer.md](mcp-resource-transfer.md).

## Exit

Evidence → ADR-003. Not canonical storage format — transport adapter only.
