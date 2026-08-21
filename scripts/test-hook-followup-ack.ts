/**
 * Hook followup ack regression (no browser).
 * Ensures FAILED/QUEUED cannot re-notify after claim.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initDatabase,
  resetDatabaseForTests,
  SCHEMA_USER_VERSION,
  getDatabase,
} from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const dir = mkdtempSync(join(tmpdir(), "handoff-hook-ack-"));
const dbPath = join(dir, "t.sqlite");

try {
  resetDatabaseForTests();
  initDatabase(dbPath);
  const db = getDatabase();
  const ver = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  assert(ver === SCHEMA_USER_VERSION, `expected schema v${SCHEMA_USER_VERSION}, got ${ver}`);

  const cols = (
    db.prepare("PRAGMA table_info(handoff_tasks)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert(cols.includes("cursor_followup_at"), "missing cursor_followup_at");
  assert(
    cols.includes("cursor_wait_notified_at"),
    "missing cursor_wait_notified_at"
  );

  const repo = new TaskRepository(db);
  const service = new TaskService(repo);
  const conv = "conv-hook-ack-test";

  const { taskId } = service.createTask({
    type: "research",
    prompt: "hook ack test",
    cursorConversationId: conv,
  });

  assert(
    service.findPendingForConversation(conv)?.id === taskId,
    "pending should find new QUEUED task"
  );

  assert(
    service.claimWaitTimeoutNotify(taskId) === true,
    "first wait-timeout claim should succeed"
  );
  assert(
    service.claimWaitTimeoutNotify(taskId) === false,
    "second wait-timeout claim must fail"
  );
  assert(
    service.findPendingForConversation(conv) === null,
    "pending must exclude wait-timeout-notified QUEUED"
  );

  // Force FAILED without going through worker.
  db.prepare(
    `UPDATE handoff_tasks
     SET status = 'FAILED', error = 'test', completed_at = ?
     WHERE id = ?`
  ).run(new Date().toISOString(), taskId);

  assert(
    service.findUnresumedTerminalForConversation(conv)?.id === taskId,
    "FAILED should be unresumed terminal"
  );
  assert(
    service.claimTerminalFollowup(taskId) === true,
    "first terminal claim should succeed"
  );
  assert(
    service.claimTerminalFollowup(taskId) === false,
    "second terminal claim must fail"
  );
  assert(
    service.findUnresumedTerminalForConversation(conv) === null,
    "after claim, unresumed terminal must be empty"
  );

  console.log("test:hook-followup-ack PASS");
} finally {
  resetDatabaseForTests();
  rmSync(dir, { recursive: true, force: true });
}
