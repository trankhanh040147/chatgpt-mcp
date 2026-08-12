# Task Plan: Attach real Chrome Pro CDP

## Goal
Worker uses the user's ChatGPT Pro session. Chrome 136+ forbids CDP on the Default profile, so the supported path is a dedicated `--user-data-dir` where the user signs into Pro — not attaching to daily Chrome.

## Next Step
User: log ChatGPT Pro into the CDP Chrome (`./scripts/start-chrome-cdp.sh`), then restart `npm run worker`.

## Current Phase
Phase 5

## Phases

### Phase 1: Requirements & Discovery
- [x] Understand user intent (Pro account, not chrome-chatgpt-debug empty session)
- [x] Confirm two Chrome processes (Default 150 vs debug 151 on :9222)
- [x] Handoff `ho_01KZSRFFB3F93PMN4AS39QKAT1` + official Chrome 136 docs
- [x] Document in findings.md
- **Status:** complete

### Phase 2: Planning & Structure
- [x] Evaluate handoff vs official docs
- [x] Choose dedicated-profile + Pro login (not Auto Connect / not Default+9222)
- **Status:** complete

### Phase 3: Implementation
- [x] Fix README / .env.example / spec to match Chrome 136
- [x] Add launch script for the CDP Chrome
- **Status:** complete

### Phase 4: Testing & Verification
- [x] Script exists and docs no longer tell users to debug Default
- **Status:** complete

### Phase 5: Delivery
- [x] Tell user how to log Pro into the CDP Chrome
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Do not launch Default with `--remote-debugging-port` | Chrome 136+ ignores those switches on the default data dir (official) |
| Do not implement Chrome 144 Auto Connect now | That flow is for chrome-devtools-mcp `--autoConnect`; Playwright `connectOverCDP` HTTP `/json/version` is broken there (#40027) |
| Keep `connectOverCDP(:9222)` + `$HOME/chrome-chatgpt-debug` | Only CDP model Chrome still documents for Stable |
| User logs ChatGPT Pro into the debug Chrome | Custom user-data-dir uses a different encryption key — copying Default cookies will not work |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Task stayed QUEUED | 1 | worker_state was STARTING; reset READY |
| Handoff suggested Default+9222 originally in our prompt | 1 | ChatGPT correctly rejected; official blog confirms |
