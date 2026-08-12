# Cursor ↔ ChatGPT Handoff MVP
## Implementation Specification — V1

**Version:** 1.0  
**Status:** MVP Chốt  
**Date:** 10/08/2026

---

# 1. Mục tiêu

Xây dựng một hệ thống cho phép:

```text
Cursor Agent
   ↓
giao một task cần external reasoning/research/review
   ↓
ChatGPT Web xử lý task bằng ChatGPT subscription
   ↓
ChatGPT ghi kết quả vào Handoff MCP
   ↓
Cursor tự nhận kết quả
   ↓
Cursor tiếp tục task ban đầu
```

Mục tiêu UX:

```text
User
 ↓
"Implement feature X"
 ↓
Cursor làm việc
 ↓
Cursor tự handoff khi cần
 ↓
ChatGPT xử lý
 ↓
Cursor tự tiếp tục
 ↓
User nhận final result
```

Sau bước setup đầu tiên, workflow hướng tới **near-zero-touch**.

Không đặt mục tiêu V1 là unattended production service 24/7.

---

# 2. Constraints

MVP bắt buộc tuân thủ:

```text
NO OpenAI Responses API inference
NO Codex
NO scraping ChatGPT assistant output
NO parsing assistant DOM
NO auto bypass CAPTCHA
NO auto bypass confirmation
NO rate-limit bypass
```

Sử dụng:

```text
Cursor IDE Agent
ChatGPT Web
ChatGPT Developer Mode
MCP
Playwright
Cursor Hooks
SQLite
TypeScript
```

Playwright chỉ chịu trách nhiệm:

```text
✓ attach vào Chrome đang chạy (CDP)
✓ goto CHATGPT_WORKER_URL
✓ nhập task_id
✓ submit message
```

Không chịu trách nhiệm:

```text
✗ launch dedicated automation profile
✗ automating ChatGPT / Google login
✗ đọc ChatGPT response
✗ click Copy response
✗ parse markdown response
✗ scrape DOM để lấy output
```

Kết quả phải đi qua:

```text
ChatGPT
  ↓
MCP submit_result()
  ↓
SQLite
  ↓
Cursor
```

---

# 3. MVP Scope

## 3.1 Included

V1 implement:

1. `Handoff MCP Server`
2. SQLite task storage
3. Cursor MCP integration
4. Cursor rule quyết định khi nào handoff
5. Cursor `preToolUse` hook inject `conversation_id`
6. Cursor `stop` hook chờ handoff trong thời gian giới hạn
7. Playwright ChatGPT dispatcher
8. Persistent ChatGPT worker conversation
9. ChatGPT MCP tools:
   - `get_task`
   - `submit_result`
10. Cursor MCP tools:
   - `create_task`
   - `get_result`
   - `get_task_status`
11. Basic retry
12. Timeout handling
13. Worker health state
14. Logging

---

# 4. Out of Scope V1

Không implement trong MVP:

```text
Multiple ChatGPT workers
Distributed queue
Redis
PostgreSQL
Cloud deployment
Automatic IDE resume sau stop-hook timeout
Automatic confirmation clicking
Automatic CAPTCHA handling
Cross-machine orchestration
Multiple Cursor machines
Task dependency graph
Agent-to-Agent protocol
Automatic repo write từ ChatGPT
Streaming ChatGPT output về Cursor
```

Không cố giải quyết:

```text
ChatGPT task > Cursor stop-hook timeout
```

bằng hack.

Nếu xảy ra:

```text
task completes after Cursor timeout
```

task được đánh dấu:

```text
READY_BUT_CURSOR_IDLE
```

và cần recovery ở V2 hoặc một manual resume nhỏ.

---

# 5. Architecture

```text
┌──────────────────────────────────────┐
│              USER                    │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│          Cursor IDE Agent            │
│                                      │
│ .cursor/rules/chatgpt-mcp.mdc        │
└──────────────────┬───────────────────┘
                   │
                   │ MCP create_task()
                   ▼
┌──────────────────────────────────────┐
│        Handoff MCP Service           │
│                                      │
│ MCP tools                            │
│ Task Service                         │
│ SQLite                               │
│ Worker status                        │
└───────┬───────────────────▲──────────┘
        │                   │
        │ QUEUED            │ submit_result()
        ▼                   │
┌─────────────────────┐     │
│ Playwright Worker   │     │
│                     │     │
│ dispatch task_id    │     │
└─────────┬───────────┘     │
          │                 │
          ▼                 │
┌──────────────────────────────────────┐
│          ChatGPT Web                 │
│                                      │
│ persistent worker conversation       │
│ Developer Mode                       │
│ Handoff MCP                          │
└───────────────────┬──────────────────┘
                    │
                    │ get_task()
                    │ reasoning
                    │ submit_result()
                    │
                    ▼
             Handoff Service
                    │
                    │ COMPLETED
                    ▼
             Cursor stop hook
                    │
                    │ followup_message
                    ▼
               Cursor Agent
                    │
                    │ get_result()
                    ▼
               Continue task
```

---

# 6. Components

## 6.1 Handoff MCP Service

Technology:

```text
Node.js
TypeScript
Official MCP SDK
SQLite
```

Responsibilities:

```text
Task persistence
Task state transitions
Expose MCP tools
Cursor conversation mapping
ChatGPT result storage
Worker status
Timeout/retry metadata
```

Recommended server:

```text
localhost:8787
```

Possible MCP transports:

```text
Cursor:
stdio or HTTP

ChatGPT:
remote MCP / Secure MCP Tunnel
```

MVP business logic không phụ thuộc transport.

---

# 7. Project Structure

```text
chatgpt-mcp/
│
├── package.json
├── tsconfig.json
├── .env
│
├── src/
│   ├── index.ts
│   │
│   ├── mcp/
│   │   ├── server.ts
│   │   └── tools/
│   │       ├── create-task.ts
│   │       ├── get-task.ts
│   │       ├── get-result.ts
│   │       ├── submit-result.ts
│   │       └── get-task-status.ts
│   │
│   ├── tasks/
│   │   ├── task.service.ts
│   │   ├── task.repository.ts
│   │   ├── task.types.ts
│   │   └── task-state.ts
│   │
│   ├── db/
│   │   ├── sqlite.ts
│   │   ├── schema.sql
│   │   └── migrations/
│   │
│   ├── browser/
│   │   ├── worker.ts
│   │   ├── chatgpt.ts
│   │   ├── selectors.ts
│   │   └── worker-state.ts
│   │
│   └── logging/
│       └── logger.ts
│
├── cursor/
│   ├── inject-session.py
│   └── wait-handoff.py
│
├── .cursor/
│   ├── hooks.json
│   └── rules/
│       └── chatgpt-mcp.mdc
│
├── data/
│   └── handoff.sqlite
│
└── logs/
```

---

# 8. Task Model

```ts
type HandoffTaskStatus =
  | "QUEUED"
  | "DISPATCHING"
  | "DISPATCHED"
  | "PROCESSING"
  | "WAITING_APPROVAL"
  | "RATE_LIMITED"
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "READY_BUT_CURSOR_IDLE"
  | "CANCELLED";
```

Task:

```ts
interface HandoffTask {
  id: string;

  cursorConversationId: string;

  type:
    | "research"
    | "code_review"
    | "architecture_review"
    | "second_opinion"
    | "debug_analysis";

  prompt: string;

  context?: {
    objective?: string;
    currentApproach?: string;
    constraints?: string[];
    relevantFiles?: string[];
    gitDiff?: string;
  };

  status: HandoffTaskStatus;

  result?: string;

  resultMetadata?: {
    summary?: string;
    confidence?: "low" | "medium" | "high";
  };

  retryCount: number;

  createdAt: string;
  dispatchedAt?: string;
  processingAt?: string;
  completedAt?: string;

  error?: string;
}
```

---

# 9. Database Schema

```sql
CREATE TABLE handoff_tasks (
    id TEXT PRIMARY KEY,

    cursor_conversation_id TEXT NOT NULL,

    type TEXT NOT NULL,
    prompt TEXT NOT NULL,
    context_json TEXT,

    status TEXT NOT NULL,

    result TEXT,
    result_metadata_json TEXT,

    retry_count INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL,
    dispatched_at TEXT,
    processing_at TEXT,
    completed_at TEXT,

    error TEXT
);

CREATE INDEX idx_handoff_status
ON handoff_tasks(status);

CREATE INDEX idx_cursor_conversation
ON handoff_tasks(cursor_conversation_id);
```

Worker:

```sql
CREATE TABLE worker_state (
    id TEXT PRIMARY KEY,

    status TEXT NOT NULL,

    last_seen_at TEXT,
    current_task_id TEXT,

    error TEXT
);
```

Worker status:

```text
READY
BUSY
NEEDS_APPROVAL
RATE_LIMITED
SESSION_LOST
ERROR
```

---

# 10. MCP API

## 10.1 `handoff.create_task`

Caller:

```text
Cursor
```

Input:

```json
{
  "type": "architecture_review",
  "prompt": "Review this implementation approach...",
  "context": {
    "objective": "...",
    "constraints": [],
    "relevantFiles": []
  }
}
```

`cursorConversationId` không cần model tự truyền.

`preToolUse` hook inject field này.

Internal final input:

```json
{
  "type": "architecture_review",
  "prompt": "...",
  "cursorConversationId": "abc-123"
}
```

Output:

```json
{
  "taskId": "ho_01J8ABC",
  "status": "QUEUED"
}
```

---

## 10.2 `handoff.get_task`

Caller:

```text
ChatGPT
```

Input:

```json
{
  "taskId": "ho_01J8ABC"
}
```

Output:

```json
{
  "taskId": "ho_01J8ABC",
  "type": "architecture_review",
  "prompt": "...",
  "context": {},
  "status": "DISPATCHED"
}
```

Side effect:

```text
DISPATCHED
    ↓
PROCESSING
```

---

## 10.3 `handoff.submit_result`

Caller:

```text
ChatGPT
```

Input:

```json
{
  "taskId": "ho_01J8ABC",
  "result": "...",
  "metadata": {
    "summary": "...",
    "confidence": "high"
  }
}
```

Output:

```json
{
  "success": true,
  "status": "COMPLETED"
}
```

Transition:

```text
PROCESSING
    ↓
COMPLETED
```

---

## 10.4 `handoff.get_result`

Caller:

```text
Cursor
```

Input:

```json
{
  "taskId": "ho_01J8ABC"
}
```

Output:

```json
{
  "status": "COMPLETED",
  "result": "...",
  "metadata": {}
}
```

---

## 10.5 `handoff.get_task_status`

Input:

```json
{
  "taskId": "ho_01J8ABC"
}
```

Output:

```json
{
  "status": "PROCESSING"
}
```

Không trả result.

---

# 11. Cursor Rule

File:

```text
.cursor/rules/chatgpt-mcp.mdc
```

Content:

```text
# ChatGPT External Handoff

You have access to an external ChatGPT handoff system.

Use handoff.create_task only when an independent external
reasoning pass is likely to materially improve the result.

Good reasons to hand off:

- architecture review
- independent code review
- technical research
- checking uncertain assumptions
- comparing complex approaches
- debugging after multiple failed attempts
- validating a production-critical decision

Do NOT hand off:

- trivial coding
- formatting
- simple syntax questions
- information already available in the current context
- tasks that you can confidently complete directly

When creating a task:

1. Explain the exact question.
2. Include relevant constraints.
3. Include only necessary context.
4. Request actionable output.

After handoff.create_task succeeds:

Finish the current turn.

The handoff system may automatically resume this conversation.

When resumed:

1. Call handoff.get_result.
2. Evaluate the external result critically.
3. Incorporate useful findings.
4. Continue the original task.
5. Do not blindly trust the external result.
```

---

# 12. Cursor `preToolUse` Hook

Purpose:

```text
inject Cursor conversation_id
```

Cursor Agent calls:

```text
handoff.create_task({
    prompt: "...",
    type: "research"
})
```

Hook receives:

```json
{
  "conversation_id": "abc-123",
  "tool_name": "MCP:handoff_create_task",
  "tool_input": {}
}
```

Hook returns:

```json
{
  "updated_input": {
    "prompt": "...",
    "type": "research",
    "cursorConversationId": "abc-123"
  }
}
```

Pseudo Python:

```python
import json
import sys

event = json.load(sys.stdin)

tool_input = event.get("tool_input", {})
conversation_id = event.get("conversation_id")

tool_input["cursorConversationId"] = conversation_id

print(json.dumps({
    "updated_input": tool_input
}))
```

---

# 13. Cursor Stop Hook

V1 strategy:

```text
bounded polling
```

Không infinite wait.

Configuration target:

```text
8 minutes
```

Flow:

```text
Cursor turn stops
     ↓
find incomplete handoff for conversation_id
     ↓
none
     → return immediately

pending task
     ↓
poll SQLite / local service
     ↓
COMPLETED before timeout
     ↓
return followup_message
```

Output:

```json
{
  "followup_message":
    "External ChatGPT handoff ho_01J8ABC completed. Call handoff.get_result with taskId ho_01J8ABC, evaluate the result, and continue the original task."
}
```

Cursor auto-submits this message.

---

# 14. Stop Hook Timeout

Recommended:

```text
HANDOFF_WAIT_TIMEOUT = 480 seconds
POLL_INTERVAL = 2 seconds
```

If:

```text
ChatGPT completion < 8 min
```

full automation works.

If:

```text
ChatGPT completion > 8 min
```

hook exits.

When result later arrives:

```text
COMPLETED
    ↓
READY_BUT_CURSOR_IDLE
```

Do not attempt undocumented IDE wake-up.

MVP logs:

```text
Task ho_x completed after Cursor wait timeout.
Manual resume required.
```

---

# 15. `.cursor/hooks.json`

Conceptual configuration:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "matcher": "MCP:handoff_create_task",
        "command": "python cursor/inject-session.py"
      }
    ],
    "stop": [
      {
        "command": "python cursor/wait-handoff.py",
        "timeout": 500,
        "loop_limit": null
      }
    ]
  }
}
```

Exact matcher/tool naming phải được xác nhận khi MCP server đã expose tool thực tế.

---

# 16. ChatGPT Worker

## 16.1 Persistent Conversation

Không tạo conversation mới cho từng task.

Dùng một conversation cố định:

```text
Cursor Handoff Worker
```

Reason:

```text
MCP write confirmation có thể được remembered
trong conversation hiện tại.
```

Nếu mỗi task tạo conversation mới:

```text
task
 ↓
new chat
 ↓
submit_result
 ↓
confirmation

next task
 ↓
new chat
 ↓
confirmation
```

không đạt near-zero-touch.

---

# 17. ChatGPT Worker Instructions

Prompt/setup cố định:

```text
You are a dedicated external reasoning worker for Cursor.

Each handoff task is independent.

When you receive a TASK_ID:

1. Call handoff.get_task with that TASK_ID.
2. Treat the returned task as the authoritative task context.
3. Do not rely on previous handoff tasks in this conversation.
4. Perform the requested reasoning, research, analysis, or review.
5. Produce actionable output intended for another coding agent.
6. ALWAYS call handoff.submit_result before finishing.
7. Do not modify repository files unless a future task explicitly allows it.
8. Never invent repository information you did not receive.
9. If information is insufficient, clearly state the limitation in the result.
```

---

# 18. Playwright Dispatcher

## 18.1 Responsibilities

Worker loop:

```text
query SQLite
    ↓
find oldest QUEUED task
    ↓
worker READY?
    ↓
yes
    ↓
mark DISPATCHING
    ↓
activate ChatGPT
    ↓
open persistent worker conversation
    ↓
submit TASK_ID
    ↓
mark DISPATCHED
```

Message sent:

```text
Process Cursor handoff TASK_ID=ho_01J8ABC.

Use the Handoff MCP tools and follow the worker instructions.
```

Nothing else.

Do not paste large context.

---

# 19. Why Task ID Only

Bad:

```text
Playwright sends:

30k source code
requirements
git diff
logs
prompt
```

Good:

```text
Playwright sends:

TASK_ID=ho_01J8ABC
```

Then:

```text
ChatGPT
   ↓
get_task()
   ↓
structured authoritative context
```

Benefits:

```text
less UI automation
less selector risk
less text corruption
simpler retries
task remains durable
easier logging
```

---

# 20. Browser Worker State Machine

```text
STARTING
   ↓
READY
   ↓
DISPATCHING
   ↓
BUSY
   ↓
READY
```

Failure branches:

```text
BUSY
 ├── NEEDS_APPROVAL
 ├── RATE_LIMITED
 ├── SESSION_LOST
 └── ERROR
```

---

# 21. Browser Selectors

Centralize all selectors:

```text
src/browser/selectors.ts
```

Never scatter selectors.

Example:

```ts
export const selectors = {
  composer: "...",
  sendButton: "...",
  conversationTitle: "..."
};
```

Use semantic selectors where possible:

```text
role
aria-label
contenteditable
```

Avoid:

```text
nth-child
deep CSS chains
generated class names
```

---

# 22. Browser Session

Attach to an already-running Chrome via CDP.

Chrome 136+ does **not** honor `--remote-debugging-port` / `--remote-debugging-pipe` against the default user-data-dir. The worker therefore attaches to a dedicated CDP Chrome (`--user-data-dir` pointing at a non-standard directory). The user must sign into ChatGPT in **that** window. Do not copy the Default profile (different encryption key). Chrome 144+ `chrome://inspect/#remote-debugging` Auto Connect is a different protocol (chrome-devtools-mcp); it is not this worker's Playwright `connectOverCDP(http://127.0.0.1:9222)` path.

```text
CHATGPT_CDP_ENDPOINT=http://127.0.0.1:9222
CHATGPT_WORKER_URL=https://chatgpt.com/c/<worker-chat-id>
```

Startup:

```ts
const browser = await chromium.connectOverCDP(cdpEndpoint);
// navigate to CHATGPT_WORKER_URL — no sidebar title lookup
```

Do **not** use `launchPersistentContext()` as the worker's browser launcher. A dedicated `--user-data-dir` for CDP is required by Chrome 136+ and is not the same as Playwright launching its own automation profile.

Do not implement credential/password automation.

If the attached Chrome is logged out → `SESSION_NOT_READY` / fail. No login fallback to bundled Chromium.

---

# 23. First-Time Setup

Initial setup requires manual actions:

```text
1. Login ChatGPT
2. Enable Developer Mode
3. Connect Handoff MCP
4. Open/create "Cursor Handoff Worker"
5. Test get_task
6. Test submit_result
7. Approve write tool
8. Remember approval for conversation if available
```

After that worker can operate with minimal interaction while session remains healthy.

---

# 24. Confirmation Handling

Never auto-click approval in MVP.

Detect operationally:

```text
task DISPATCHED
and
no submit_result after threshold
```

Possible state:

```text
WAITING_APPROVAL
```

Worker state:

```text
NEEDS_APPROVAL
```

Surface log:

```text
ChatGPT worker may require MCP write approval.
Open worker conversation and review.
```

After user approval:

```text
worker READY
```

---

# 25. Rate Limit Handling

Rate limit must be first-class state.

```text
RATE_LIMITED
```

Do not retry every few seconds.

Suggested retry:

```text
5 min
15 min
30 min
```

Maximum V1:

```text
3 retries
```

Then:

```text
FAILED
```

---

# 26. Task Retry Policy

Dispatch failures:

```text
retry_count < 3
    ↓
QUEUED
```

After max:

```text
FAILED
```

Do not automatically retry ChatGPT reasoning if `submit_result()` has already occurred.

`submit_result()` must be idempotent.

---

# 27. Idempotency

Critical requirement.

Calling:

```text
submit_result(task_id)
```

twice must not create duplicate task completion.

Implementation:

```text
if status == COMPLETED:
    return existing completion
```

Same for dispatch:

```text
DISPATCHED task
```

must not be redispatched unless explicit retry policy says so.

---

# 28. Locking

Only one browser worker in MVP.

When taking task:

```sql
BEGIN IMMEDIATE;
```

Select oldest:

```text
QUEUED
```

mark:

```text
DISPATCHING
```

commit.

Prevents accidental duplicate dispatch.

---

# 29. Logging

Every state transition:

```json
{
  "timestamp": "...",
  "taskId": "ho_01J8ABC",
  "from": "QUEUED",
  "to": "DISPATCHING",
  "component": "browser-worker"
}
```

Important events:

```text
TASK_CREATED
TASK_DISPATCHED
CHATGPT_PROCESSING
RESULT_RECEIVED
CURSOR_RESUMED
CURSOR_WAIT_TIMEOUT
WORKER_SESSION_LOST
WORKER_NEEDS_APPROVAL
RATE_LIMITED
TASK_FAILED
```

---

# 30. Security

MVP MCP must not expose arbitrary filesystem access.

For V1:

```text
ChatGPT receives task context only.
```

Do not expose:

```text
read_file("/")
shell()
exec()
write_file()
git_push()
```

If future `repo.read_file` added:

```text
workspace allowlist
path traversal protection
secret filtering
file size limit
read-only
```

---

# 31. Secrets

Never send through handoff context:

```text
.env
API keys
access tokens
SSH private keys
cookies
passwords
credentials
```

Add sanitizer before DB insertion.

Initial simple patterns:

```text
sk-...
ghp_...
-----BEGIN PRIVATE KEY-----
Bearer ...
password=
secret=
```

False positives acceptable in MVP.

---

# 32. Context Budget

`create_task` should not dump entire repo.

Cursor should send:

```text
objective
question
constraints
selected files
relevant snippets
relevant diff
failed approaches
```

Target:

```text
< 15k tokens context
```

where possible.

---

# 33. Recommended Handoff Types

## Research

```text
Need external/current technical knowledge.
```

## Architecture Review

```text
Need independent design critique.
```

## Code Review

```text
Need independent review of current diff.
```

## Debug Analysis

```text
Cursor attempted multiple fixes without confidence.
```

## Second Opinion

```text
Important decision with multiple plausible approaches.
```

---

# 34. When Cursor Must NOT Handoff

Avoid handoff for:

```text
rename variable
simple bug
formatting
small refactor
known syntax
routine test fixes
tasks answerable from local code
```

Goal is not:

```text
Cursor delegates everything to ChatGPT
```

Goal:

```text
Cursor uses ChatGPT as expensive external reasoning worker.
```

---

# 35. End-to-End Sequence

```text
1. User → Cursor:
   "Implement production-ready intent pre-router."

2. Cursor:
   inspect code
   implement
   identify uncertain architecture decision

3. Cursor:
   handoff.create_task()

4. preToolUse:
   inject conversation_id

5. DB:
   QUEUED

6. Browser Worker:
   pick task

7. Browser Worker:
   submit TASK_ID to ChatGPT

8. DB:
   DISPATCHED

9. ChatGPT:
   get_task()

10. DB:
    PROCESSING

11. ChatGPT:
    reason / research / review

12. ChatGPT:
    submit_result()

13. DB:
    COMPLETED

14. Cursor stop hook:
    sees COMPLETED

15. Stop hook:
    followup_message

16. Cursor:
    get_result()

17. Cursor:
    evaluates result

18. Cursor:
    continues implementation

19. Cursor:
    tests

20. Cursor:
    final response to user
```

---

# 36. MVP Happy Path Acceptance Test

Test task:

```text
Cursor:
"Create a simple TypeScript function, but first obtain
an independent review of two possible API designs."
```

Expected:

```text
Cursor create_task
    ↓
DB QUEUED
    ↓
Playwright dispatch
    ↓
ChatGPT get_task
    ↓
ChatGPT submit_result
    ↓
DB COMPLETED
    ↓
Cursor hook followup
    ↓
Cursor get_result
    ↓
Cursor continues
```

No user interaction after initial worker setup.

---

# 37. MVP Acceptance Criteria

MVP considered successful when:

### Functional

```text
[ ] Cursor creates handoff
[ ] conversation_id mapped correctly
[ ] task persisted
[ ] browser dispatches automatically
[ ] ChatGPT receives correct TASK_ID
[ ] ChatGPT successfully calls get_task
[ ] ChatGPT successfully calls submit_result
[ ] result persisted
[ ] Cursor stop hook detects completion
[ ] Cursor auto-receives followup_message
[ ] Cursor calls get_result
[ ] Cursor continues original task
```

### Reliability

Run:

```text
20 consecutive handoffs
```

Target:

```text
>= 18 complete with no manual intervention
```

excluding explicit:

```text
ChatGPT approval
ChatGPT quota
network outage
```

---

# 38. Definition of MVP Success

Do not judge by:

```text
Can ChatGPT call MCP?
```

That alone is insufficient.

MVP succeeds only if this **vertical slice** works repeatedly:

```text
Cursor
  create_task
      ↓
Playwright
  submit task
      ↓
ChatGPT
  get_task
  reason
  submit_result
      ↓
Cursor
  auto resume
  get_result
  continue
```

---

# 39. Implementation Order

## Phase 1 — Handoff Core

Implement:

```text
SQLite
Task model
create_task
get_task
submit_result
get_result
```

Test manually with MCP clients.

---

## Phase 2 — ChatGPT MCP

Connect MCP to Developer Mode.

Manually execute:

```text
get_task
submit_result
```

Verify DB transitions.

---

## Phase 3 — Browser Dispatcher

Implement Playwright.

First test:

```text
QUEUE TASK
    ↓
automatic TASK_ID submission
```

Ignore Cursor resume initially.

---

## Phase 4 — Cursor Integration

Configure MCP.

Implement:

```text
handoff rule
preToolUse
conversation_id injection
```

---

## Phase 5 — Auto Resume

Implement:

```text
stop hook
bounded polling
followup_message
```

Then test full vertical slice.

---

## Phase 6 — Failure Handling

Add:

```text
timeout
retry
rate-limit states
worker health
session-loss detection
logging
```

---

# 40. Build Milestone

## M0

```text
MCP task CRUD works
```

## M1

```text
ChatGPT manually processes TASK_ID
```

## M2

```text
Playwright automatically dispatches
```

## M3

```text
Cursor automatically creates task
```

## M4

```text
Cursor automatically resumes
```

## M5 — MVP DONE

```text
20-task reliability test
```

---

# 41. Primary Risks

## Risk 1 — ChatGPT UI changes

Impact:

```text
Playwright dispatcher breaks
```

Mitigation:

```text
selectors centralized
minimal browser interactions
task ID only
headed browser
logging/screenshots on failure
```

---

## Risk 2 — MCP confirmation returns

Causes:

```text
refresh
new worker conversation
session changes
```

Impact:

```text
task stuck
```

Mitigation:

```text
persistent conversation
NEEDS_APPROVAL worker state
manual approval recovery
```

---

## Risk 3 — ChatGPT quota

Impact:

```text
RATE_LIMITED
```

Mitigation:

```text
first-class state
backoff
no busy retry
```

---

## Risk 4 — Cursor hook timeout

Impact:

```text
result available but Cursor idle
```

Mitigation V1:

```text
bounded task SLA
READY_BUT_CURSOR_IDLE
manual recovery
```

Proper event-driven IDE resume deferred to V2.

---

# 42. MVP SLA

Handoff tasks should normally be selected such that expected processing time is:

```text
< 5 minutes
```

Cursor hook timeout:

```text
8 minutes
```

This leaves some buffer.

Do not handoff massive tasks such as:

```text
"Analyze entire repository"
```

Prefer decomposition:

```text
"Review authentication architecture based on these 4 files."
```

---

# 43. V2 Backlog

After MVP proves reliable:

```text
Event-driven resume
Cursor CLI/SDK-native agents
Multiple ChatGPT workers
Task priority
Task cancellation
Structured result schema
Artifact storage
repo.read_file
repo.search
git diff tools
Context compression
Task dependency graph
Dashboard
Metrics
Secure MCP Tunnel hardening
```

Do not start these before vertical slice passes.

---

# 44. Final MVP Decision

**Stack**

```text
TypeScript
Node.js
Official MCP SDK
SQLite
Playwright
Python Cursor Hooks
ChatGPT Developer Mode
Cursor IDE Agent
```

**ChatGPT architecture**

```text
1 persistent worker conversation
```

**Browser automation**

```text
dispatch only
```

**Result transport**

```text
MCP only
```

**Cursor resume**

```text
bounded stop-hook + followup_message
```

**Database**

```text
SQLite
```

**Concurrency**

```text
1 task at a time
```

**Target**

```text
Personal near-zero-touch workflow
```

**Non-goal**

```text
24/7 fully unattended production service
```

---

# 45. One-Line Architecture

```text
Cursor creates durable task → Playwright tells ChatGPT its task ID →
ChatGPT reads/writes through MCP → Cursor stop hook sees completion →
Cursor gets result and continues.
```

Đây là scope nên implement trước. Chỉ khi vertical slice này chạy ổn định khoảng **20 handoff liên tiếp** mới mở rộng sang V2.