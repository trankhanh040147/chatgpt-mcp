#!/usr/bin/env npx tsx
/**
 * Unblock a stuck handoff queue after worker crash / lease / DISPATCHING.
 *
 *   npm run recover
 *   npm run recover -- --fail-queued
 *   npm run recover -- --purge
 */
import { config as loadEnv } from "dotenv";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { initDatabase } from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";

const repoRoot = process.cwd();
loadEnv({ path: join(repoRoot, ".env") });

function resolveUserPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(join(homedir(), trimmed.slice(2)));
  return resolve(trimmed);
}

function defaultDbPath(): string {
  const home = resolveUserPath(
    process.env.CHATGPT_MCP_HOME?.trim() || join(homedir(), ".chatgpt-mcp")
  );
  return resolveUserPath(
    process.env.HANDOFF_DB_PATH?.trim() || join(home, "data", "handoff.sqlite")
  );
}

const args = process.argv.slice(2);
const failQueued = args.includes("--fail-queued");
const failOpen = args.includes("--fail-open");
const purge = args.includes("--purge");
const keepIdx = args.indexOf("--keep");
const keepId = keepIdx >= 0 ? args[keepIdx + 1] : undefined;
const idIdx = args.indexOf("--id");
const purgeId = idIdx >= 0 ? args[idIdx + 1] : undefined;

const db = initDatabase(defaultDbPath());
const repo = new TaskRepository(db);
const now = new Date().toISOString();

if (purge) {
  if (idIdx >= 0 && (!purgeId || purgeId.startsWith("-"))) {
    console.error("recover --purge --id: expected a task id (ho_…)");
    process.exit(1);
  }
  if (purgeId && keepId) {
    console.error("recover --purge: use --id or --keep, not both");
    process.exit(1);
  }
  if (purgeId && !purgeId.startsWith("ho_")) {
    console.error("recover --purge --id: expected a task id (ho_…)");
    process.exit(1);
  }

  let deleted = 0;
  if (purgeId) {
    deleted = db.prepare(`DELETE FROM handoff_tasks WHERE id = ?`).run(purgeId).changes;
  } else if (keepId) {
    deleted = db
      .prepare(`DELETE FROM handoff_tasks WHERE id != ?`)
      .run(keepId).changes;
  } else {
    deleted = db.prepare(`DELETE FROM handoff_tasks`).run().changes;
  }

  db.prepare(
    `UPDATE worker_state
     SET status = 'READY',
         current_task_id = NULL,
         error = NULL,
         last_seen_at = ?,
         instance_token = NULL,
         pid = NULL`
  ).run(now);

  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM handoff_tasks`).get() as {
    n: number;
  };

  console.log("clear-tasks:");
  console.log(`  deleted: ${deleted}`);
  console.log(`  remaining: ${remaining.n}`);
  console.log("  all worker_state → READY");
  process.exit(0);
}

// Expire leases first (requeue pre-fence / TIMED_OUT post-fence).
const expired = repo.expireLeases(now);

const dispatching = db
  .prepare(
    `UPDATE handoff_tasks
     SET status = 'FAILED',
         error = 'Recovered: stuck DISPATCHING (make recover)',
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
     WHERE status = 'DISPATCHING'`
  )
  .run();

const legacyWaiting = db
  .prepare(
    `UPDATE handoff_tasks
     SET status = 'TIMED_OUT',
         error = 'Recovered: legacy WAITING_APPROVAL (make recover)',
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
     WHERE status = 'WAITING_APPROVAL'`
  )
  .run();

let queuedChanged = 0;
if (failQueued) {
  if (keepId) {
    queuedChanged = db
      .prepare(
        `UPDATE handoff_tasks
         SET status = 'FAILED', error = 'Recovered: superseded QUEUED (make recover)',
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
         WHERE status = 'QUEUED' AND id != ?`
      )
      .run(keepId).changes;
  } else {
    queuedChanged = db
      .prepare(
        `UPDATE handoff_tasks
         SET status = 'FAILED', error = 'Recovered: superseded QUEUED (make recover)',
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
         WHERE status = 'QUEUED'`
      )
      .run().changes;
  }
}

let openChanged = 0;
if (failOpen) {
  if (keepId) {
    openChanged = db
      .prepare(
        `UPDATE handoff_tasks
         SET status = 'FAILED', error = 'Recovered: superseded open task (make recover)',
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
         WHERE status IN ('DISPATCHED','PROCESSING','WAITING_APPROVAL')
           AND id != ?`
      )
      .run(keepId).changes;
  } else {
    openChanged = db
      .prepare(
        `UPDATE handoff_tasks
         SET status = 'FAILED', error = 'Recovered: superseded open task (make recover)',
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
         WHERE status IN ('DISPATCHED','PROCESSING','WAITING_APPROVAL')`
      )
      .run().changes;
  }
}

db.prepare(
  `UPDATE worker_state
   SET status = 'READY',
       current_task_id = NULL,
       error = NULL,
       last_seen_at = ?,
       instance_token = NULL,
       pid = NULL`
).run(now);

const open = db
  .prepare(
    `SELECT id, status, lease_owner FROM handoff_tasks
     WHERE status IN ('QUEUED','DISPATCHING','DISPATCHED','PROCESSING','WAITING_APPROVAL')
     ORDER BY created_at ASC`
  )
  .all();

const workers = repo.listWorkers();

console.log("recover:");
console.log(
  `  expireLeases: requeued=${expired.requeued} timedOut=${expired.timedOut} failed=${expired.failed}`
);
console.log(`  DISPATCHING → FAILED: ${dispatching.changes}`);
console.log(`  WAITING_APPROVAL → TIMED_OUT: ${legacyWaiting.changes}`);
if (failQueued) console.log(`  QUEUED → FAILED: ${queuedChanged}`);
if (failOpen) console.log(`  open (DISPATCHED/…) → FAILED: ${openChanged}`);
console.log(`  all worker_state → READY (${workers.length} rows)`);
console.log("open tasks:", open.length ? open : "(none)");
for (const row of open as Array<{ id: string; status: string; lease_owner: string | null }>) {
  console.log(`  - ${row.id}  ${row.status}  owner=${row.lease_owner ?? "-"}`);
}
