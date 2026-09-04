#!/usr/bin/env npx tsx
/**
 * MCP writeback contract tests (v0.8 Phase 3).
 *   npm run test:writeback-contract
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SUBMIT_RESULT_TOOL_DESCRIPTION,
  WRITEBACK_POLICY,
} from "../src/mcp/worker-policy.js";
import {
  recordCursorSessionHint,
  resolveCursorSessionHint,
} from "../src/mcp/cursor-session-hint.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  resetDatabaseForTests,
} from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";
import { HandoffFileError } from "../src/tasks/task.types.js";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed += 1;
    console.error(`FAIL: ${msg}`);
  } else {
    passed += 1;
    console.log(`ok — ${msg}`);
  }
}

function main(): void {
  const policyText = JSON.stringify(WRITEBACK_POLICY);
  assert(
    WRITEBACK_POLICY.whenToWrite.some((line) =>
      line.includes("complete final file content")
    ),
    "policy: complete final content rule"
  );
  assert(
    WRITEBACK_POLICY.onRejection.some((line) =>
      line.toLowerCase().includes("do not automatically switch to overwrite")
    ),
    "policy: create collision must not auto overwrite"
  );
  assert(
    !policyText.includes("10 files") && !policyText.includes("max 10"),
    "policy: no stale 10-file limit"
  );

  assert(
    SUBMIT_RESULT_TOOL_DESCRIPTION.includes("20") &&
      SUBMIT_RESULT_TOOL_DESCRIPTION.includes("artifacts"),
    "tool description: 20 artifacts"
  );
  assert(
    SUBMIT_RESULT_TOOL_DESCRIPTION.includes("32MiB") ||
      SUBMIT_RESULT_TOOL_DESCRIPTION.includes("32 MiB"),
    "tool description: 32 MiB per file"
  );
  assert(
    SUBMIT_RESULT_TOOL_DESCRIPTION.includes("128MiB") ||
      SUBMIT_RESULT_TOOL_DESCRIPTION.includes("128 MiB"),
    "tool description: 128 MiB total"
  );
  assert(
    SUBMIT_RESULT_TOOL_DESCRIPTION.toLowerCase().includes("archive") &&
      SUBMIT_RESULT_TOOL_DESCRIPTION.includes("tar.zst"),
    "tool description: archive tar.zst path"
  );
  assert(
    !SUBMIT_RESULT_TOOL_DESCRIPTION.includes("10 files"),
    "tool description: no stale 10-file limit"
  );
  assert(
    /prose in result does NOT write/i.test(SUBMIT_RESULT_TOOL_DESCRIPTION),
    "tool description: prose does not write disk"
  );
  assert(
    WRITEBACK_POLICY.submission.some((line) =>
      /artifacts\[\] or archive is required/i.test(line)
    ),
    "policy: artifacts or archive required when modifying files"
  );

  const err = new HandoffFileError(
    "FILES_INVALID",
    "Create target already exists (src/foo.ts)"
  );
  assert(err.code === "FILES_INVALID", "HandoffFileError: code preserved");
  assert(
    err.message.includes("src/foo.ts"),
    "HandoffFileError: safe path in message"
  );
  assert(
    !err.message.includes("sk-"),
    "HandoffFileError: no secret leakage in message shape test"
  );

  resetDatabaseForTests();
  const dbDir = mkdtempSync(join(tmpdir(), "writeback-contract-"));
  const dbPath = join(dbDir, "handoff.sqlite");
  initDatabase(dbPath);
  const service = new TaskService(new TaskRepository(getDatabase()));

  const { taskId } = service.createTask({
    type: "second_opinion",
    prompt: "writeback required test",
    context: {
      writebackRequired: true,
      submitTemplate: {
        result: "ok",
        artifacts: [{ path: "a.ts", content: "export {};\n", mode: "overwrite" }],
      },
    },
    cursorConversationId: "writeback-contract-test",
  });
  const ctxRow = getDatabase()
    .prepare("SELECT context_json FROM handoff_tasks WHERE id = ?")
    .get(taskId) as { context_json: string | null };
  assert(
    ctxRow.context_json?.includes("writebackRequired"),
    "runtime: writebackRequired persisted"
  );

  getDatabase()
    .prepare(
      `UPDATE handoff_tasks SET status = 'PROCESSING', dispatch_started_at = ? WHERE id = ?`
    )
    .run(new Date().toISOString(), taskId);

  let rejected = false;
  try {
    service.submitResult({ taskId, result: "prose only" });
  } catch (e) {
    rejected =
      e instanceof HandoffFileError &&
      e.code === "FILES_INVALID" &&
      /artifacts\[\] or archive required/i.test(e.message);
  }
  assert(rejected, "runtime: prose-only rejected when writebackRequired");

  getDatabase()
    .prepare(
      `UPDATE handoff_tasks SET status = 'PROCESSING', dispatch_started_at = ? WHERE id = ?`
    )
    .run(new Date().toISOString(), taskId);

  // artifact write only after completion CAS (loser must not mutate disk)
  const wsDir = mkdtempSync(join(tmpdir(), "writeback-cas-"));
  writeFileSync(join(wsDir, "race.ts"), "original\n");
  const raceTask = service.createTask({
    type: "second_opinion",
    prompt: "race",
    cursorConversationId: "writeback-race",
    files: ["race.ts"],
    workspaceRoot: wsDir,
  });
  getDatabase()
    .prepare(
      `UPDATE handoff_tasks SET status = 'PROCESSING', dispatch_started_at = ? WHERE id = ?`
    )
    .run(new Date().toISOString(), raceTask.taskId);
  service.submitResult({
    taskId: raceTask.taskId,
    result: "winner",
    artifacts: [
      { path: "race.ts", content: "winner\n", mode: "overwrite" },
    ],
  });
  let conflict = false;
  try {
    service.submitResult({
      taskId: raceTask.taskId,
      result: "loser",
      artifacts: [
        { path: "race.ts", content: "loser\n", mode: "overwrite" },
      ],
    });
  } catch {
    conflict = true;
  }
  assert(conflict, "runtime: losing submit throws idempotent conflict");
  assert(
    readFileSync(join(wsDir, "race.ts"), "utf8") === "winner\n",
    "runtime: loser did not overwrite winner artifacts"
  );
  rmSync(wsDir, { recursive: true, force: true });

  const hintsPath = join(dbDir, "cursor-session-hints.jsonl");
  process.env.HANDOFF_CURSOR_HINTS_PATH = hintsPath;
  recordCursorSessionHint({
    conversationId: "conv-hint-test-123",
    toolName: "handoff_create_task",
    prompt: "hinted handoff prompt unique",
  });
  assert(
    resolveCursorSessionHint("hinted handoff prompt unique") ===
      "conv-hint-test-123",
    "hint: resolve session from side-channel"
  );

  closeDatabase();
  rmSync(dbDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
