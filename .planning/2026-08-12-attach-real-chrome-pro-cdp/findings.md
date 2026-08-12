# Findings & Decisions

## Requirements
- Worker must use ChatGPT **Pro**, not a logged-out/free session in a clone Chrome
- No login automation, no cookie copy, no Playwright persistent-context login
- Spec still: attach via CDP, never launch bundled Chromium as login fallback

## Research Findings

### Live machine (2026-08-12)
- Daily Chrome: PID ~35592, v150, default dir `~/Library/Application Support/Google/Chrome`, **no** `--remote-debugging-port`
- Worker Chrome: PID ~22944, v151, `--remote-debugging-port=9222 --user-data-dir=/Users/vulcanlabs/chrome-chatgpt-debug`
- Worker `connectOverCDP(http://127.0.0.1:9222)` always hits the debug instance

### Handoff `ho_01KZSRFFB3F93PMN4AS39QKAT1`
- Claim: Chrome 136+ ignores `--remote-debugging-port` on default user-data-dir — **CONFIRMED**
  - https://developer.chrome.com/blog/remote-debugging-port
- Claim: Chrome 144+ Auto Connect via `chrome://inspect/#remote-debugging` can attach to the real session — **CONFIRMED as chrome-devtools-mcp**, **NOT** a drop-in for this worker
  - https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session
  - Playwright issue: https://github.com/microsoft/playwright/issues/40027 (open)
  - M144 inspect server has **no** HTTP `/json/version` (404); Playwright HTTP CDP discovery fails
- Claim that code change is required for Auto Connect: true **if** we insist on Default profile; false **if** we accept dedicated dir + Pro login

### Encryption
Non-standard `--user-data-dir` uses a different encryption key. Copying Default profile files into `chrome-chatgpt-debug` does not give working cookies/passwords.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Docs + launch script, no Auto Connect code | Playwright cannot reliably attach to inspect-remote-debugging yet |
| Pro login in dedicated Chrome | Only supported way to use Pro with raw CDP on Chrome 136+ |

## Issues Encountered
| Issue | Severity | Resolution |
|-------|----------|------------|
| README told users to use chrome-chatgpt-debug without saying they must log Pro there | High | Fix docs |
| Spec §22 sounded like “attach to already-running daily Chrome” | High | Add Chrome 136 caveat |

## Resources
- https://developer.chrome.com/blog/remote-debugging-port
- https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session
- https://github.com/microsoft/playwright/issues/40027
