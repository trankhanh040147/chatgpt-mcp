# Progress — MVP release implementation

## 2026-08-13

### Implemented
- Cross-platform CDP launcher `scripts/start-chrome-cdp.mjs` (+ `.sh` wrapper)
- Legacy profile auto-prefer `~/chrome-chatgpt-debug`; CDP ready poll
- MCP tool annotations, bounds, server instructions; shared `registerHandoffTools`
- Conditional `saveResultIfOpen` + idempotent/conflict `submitResult`
- SDK pin `1.30.0`; package `0.1.0-preview.1`
- `docs/connect-chatgpt.md` Secure Tunnel first; README platform badges + migration
- `npm run check` platform/sdk/desktop

### Self-review
- Handoff `ho_01KZW6HQG7JQT6KZ0YQMW35PS4` → ship-with-fixes → applied

### Still deferred
- Ubuntu live E2E (label remains experimental)
- Full ≥18/20 gate / A/B benchmark
- OAuth / SDK v2
