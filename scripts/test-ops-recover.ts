#!/usr/bin/env npx tsx
/**
 * Ops recover / fail-task regression (no browser).
 *   npx tsx scripts/test-ops-recover.ts
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
  executeRecover,
  failTaskById,
  planRecover,
  runRecover,
} from "../src/ops/recover.js";

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

function fresh(): {
  path: string;
  repo: TaskRepository;
  service: TaskService;
} {
  resetDatabaseForTests();
  const dir = mkdtempSync(join(tmpdir(), "handoff-ops-"));
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
  const { path, repo } = fresh();
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO worker_state (id, status, last_seen_at, pid, instance_token)
     VALUES ('w-live', 'BUSY', ?, ?, 'tok-live')`
  ).run(now, process.pid);
  const plan = planRecover(db, {});
  assert(
    !plan.workers.some((w) => w.id === "w-live"),
    "healthy live worker not in default recover plan"
  );
  const before = repo.listWorkers().find((w) => w.id === "w-live");
  runRecover(db, {});
  const after = repo.listWorkers().find((w) => w.id === "w-live");
  assert(after?.instanceToken === before?.instanceToken, "live worker token preserved");
  assert(after?.status === "BUSY", "live worker status preserved");
  cleanup(path);
}

{
  const { path } = fresh();
  const db = getDatabase();
  const old = new Date(Date.now() - 3600_000).toISOString();
  db.prepare(
    `INSERT INTO worker_state (id, status, last_seen_at, pid, instance_token)
     VALUES ('w-stale', 'BUSY', ?, 999999, 'tok-stale')`
  ).run(old);
  const plan = planRecover(db, { staleMs: 60_000 });
  assert(
    plan.workers.some((w) => w.id === "w-stale"),
    "stale worker planned for reset"
  );
  const result = executeRecover(db, plan);
  assert(result.workersReset === 1, "stale worker reset count");
  const row = db
    .prepare(`SELECT status, instance_token AS t FROM worker_state WHERE id='w-stale'`)
    .get() as { status: string; t: string | null };
  assert(row.status === "READY" && row.t == null, "stale worker cleared");
  cleanup(path);
}

{
  const { path, service } = fresh();
  const db = getDatabase();
  const { taskId } = service.createTask({
    type: "research",
    prompt: "x",
    cursorConversationId: "c1",
  });
  db.prepare(
    `UPDATE handoff_tasks SET status='DISPATCHING' WHERE id=?`
  ).run(taskId);
  const plan = planRecover(db, {});
  assert(
    plan.dispatching.some((t) => t.id === taskId),
    "DISPATCHING in plan"
  );
  assert(plan.confirmPhrase.startsWith("RECOVER "), "confirm phrase shaped");
  const dryWorkers = db
    .prepare(`SELECT COUNT(*) AS n FROM worker_state`)
    .get() as { n: number };
  planRecover(db, {});
  const afterPlan = db
    .prepare(`SELECT COUNT(*) AS n FROM worker_state`)
    .get() as { n: number };
  assert(dryWorkers.n === afterPlan.n, "planRecover is read-only for workers");
  const status = db
    .prepare(`SELECT status FROM handoff_tasks WHERE id=?`)
    .get(taskId) as { status: string };
  assert(status.status === "DISPATCHING", "planRecover does not mutate tasks");
  executeRecover(db, plan);
  const done = db
    .prepare(`SELECT status FROM handoff_tasks WHERE id=?`)
    .get(taskId) as { status: string };
  assert(done.status === "FAILED", "DISPATCHING failed on execute");
  cleanup(path);
}

{
  const { path, service } = fresh();
  const db = getDatabase();
  const { taskId } = service.createTask({
    type: "research",
    prompt: "y",
    cursorConversationId: "c2",
  });
  const fail = failTaskById(db, taskId, "test");
  assert(fail.ok && fail.previousStatus === "QUEUED", "fail queued task");
  const again = failTaskById(db, taskId, "test");
  assert(!again.ok && again.code === "conflict", "fail terminal conflicts");
  const missing = failTaskById(db, "ho_MISSING", "test");
  assert(!missing.ok && missing.code === "not_found", "fail missing 404");
  cleanup(path);
}

{
  const { path } = fresh();
  const db = getDatabase();
  const plan = planRecover(db, {});
  // Mutate after plan → stale
  db.prepare(
    `INSERT INTO worker_state (id, status, last_seen_at, pid)
     VALUES ('w-extra', 'ERROR', ?, NULL)`
  ).run(new Date(Date.now() - 3600_000).toISOString());
  let threw = false;
  try {
    executeRecover(db, plan);
  } catch (err) {
    threw =
      err instanceof Error &&
      (err as Error & { code?: string }).code === "plan_stale";
  }
  assert(threw, "executeRecover rejects stale plan");
  cleanup(path);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
