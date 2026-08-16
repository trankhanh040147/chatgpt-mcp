#!/usr/bin/env npx tsx
/**
 * Usage estimate unit tests (no browser).
 *   npm run test:usage
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initDatabase,
  resetDatabaseForTests,
  getDatabase,
  closeDatabase,
} from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";
import {
  costMicroUsd,
  estimateTaskUsage,
  loadCostConfig,
  microToUsd,
} from "../src/usage/pricing.js";
import { estimateTokensChar4 } from "../src/usage/token-estimator.js";
import {
  getTaskUsage,
  usageBundleTotal,
} from "../src/usage/task-usage.repository.js";

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

function fresh(): { path: string; service: TaskService; repo: TaskRepository } {
  resetDatabaseForTests();
  const dir = mkdtempSync(join(tmpdir(), "handoff-usage-"));
  initDatabase(join(dir, "test.sqlite"));
  const repo = new TaskRepository(getDatabase());
  return { path: dir, repo, service: new TaskService(repo) };
}

function cleanup(path: string): void {
  closeDatabase();
  resetDatabaseForTests();
  rmSync(path, { recursive: true, force: true });
}

{
  assert(estimateTokensChar4("") === 0, "char4 empty");
  assert(estimateTokensChar4("abcd") === 1, "char4 4 chars");
  const viet = estimateTokensChar4("xin chào thế giới");
  assert(viet > 0, "char4 vietnamese");
}

{
  const snap = estimateTaskUsage(
    "hello world prompt ".repeat(20),
    "result text ".repeat(10),
    loadCostConfig(true)
  );
  assert(snap.totalTokensEst === snap.inputTokensEst + snap.outputTokensEst, "total = in+out");
  assert(snap.apiEquivAvoidedMicroUsd >= 0, "cost >= 0");
  assert(snap.cashSavedMicroUsd === null, "cashSaved null");
  assert(snap.tokenScope === "stored_prompt_result_text_only", "scope");
  assert(snap.confidence === "low" || snap.confidence === "medium", "confidence");
}

{
  const micro = costMicroUsd(1_000_000, 0, 2_000_000, 10_000_000, 0, 1000);
  assert(micro === 2_000_000, "1M input @ $2 → 2e6 microUSD");
  assert(microToUsd(micro) === 2, "microToUsd 2");
}

{
  const { path, service } = fresh();
  const db = getDatabase();
  db.prepare(
    `INSERT INTO worker_state (id, status, last_seen_at, instance_token, pid)
     VALUES ('w1', 'READY', ?, 'tok', ?)`
  ).run(new Date().toISOString(), process.pid);

  const { taskId } = service.createTask({
    type: "research",
    prompt: "Estimate usage for a short handoff prompt.",
    cursorConversationId: "c-usage",
  });
  db.prepare(
    `UPDATE handoff_tasks
     SET status='PROCESSING', lease_owner='w1', dispatch_started_at=?, processing_at=?
     WHERE id=?`
  ).run(new Date().toISOString(), new Date().toISOString(), taskId);

  service.submitResult({
    taskId,
    result: "Short estimated result body for pricing tests.",
  });
  const usage = getTaskUsage(db, taskId);
  assert(Boolean(usage), "usage row after submit");
  assert((usage?.totalTokensEst ?? 0) > 0, "tokens > 0");

  const again = service.submitResult({
    taskId,
    result: "Short estimated result body for pricing tests.",
  });
  assert(again.idempotent === true, "idempotent submit");
  assert(Boolean(getTaskUsage(db, taskId)), "usage still present");

  const totals = usageBundleTotal(
    db,
    new Date(Date.now() - 86400_000).toISOString()
  );
  assert(totals.last24h.measuredTasks >= 1, "24h measured");
  assert(totals.last24h.apiEquivalentAvoidedUsd >= 0, "24h usd");

  cleanup(path);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
