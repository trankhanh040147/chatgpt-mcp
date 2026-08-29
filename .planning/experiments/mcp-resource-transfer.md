# Experiment — MCP resource transport

**Status:** SPIKE · **Lifecycle:** IDEA → SPIKE  
**Parent:** [0.6 Handoff Resources](../active/0.6-handoff-resources.md)

## Question

Does ChatGPT (Developer Mode MCP) consume task file evidence better via:

- **A.** Native MCP `resources/list` + `resources/read` (`handoff://tasks/{taskId}/resources/{fileId}`)
- **B.** Tool façade (`handoff_get_task` manifest + `handoff_read_file`) — **partially shipped**

## Hypothesis

Lazy pull (manifest → read selected files) beats pushing all bytes in `get_task` or native attachment for many small code files.

## Unknown

- ChatGPT host rendering of `EmbeddedResource` / `ResourceLink`
- Whether resource primitives work more reliably than custom tools

## Dataset

Reuse 0.6 benchmark matrix (cases A–F in active spec).

## Measure

- Dispatch / first-reasoning latency
- Bytes transferred vs files actually read
- Symbol quote accuracy
- Tool call count
- Failure recovery

## Exit

Results → [ADR-003](../decisions/ADR-003-resource-transport.md). Do **not** update roadmap ladder until ADR merged.

## Current code

Tool façade **B** shipped: `handoff_read_file(taskId, fileId)`. Resource URI primitive **A** not implemented.
