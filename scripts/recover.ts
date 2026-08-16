#!/usr/bin/env npx tsx
/**
 * Unblock a stuck handoff queue after worker crash / lease / DISPATCHING.
 *
 *   npm run recover
 *   npm run recover -- --fail-queued
 *   npm run recover -- --reset-all-workers
 *   npm run recover -- --purge
 *
 * Default worker reset is selective (stale heartbeat / dead pid / orphan task).
 * Use --reset-all-workers for the legacy wipe of every worker_state row.
 */
import { config as loadEnv } from "dotenv";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { initDatabase } from "../src/db/sqlite.js";
import { runRecover } from "../src/ops/recover.js";

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
const resetAllWorkers = args.includes("--reset-all-workers");
const purge = args.includes("--purge");
const keepIdx = args.indexOf("--keep");
const keepId = keepIdx >= 0 ? args[keepIdx + 1] : undefined;
const idIdx = args.indexOf("--id");
const purgeId = idIdx >= 0 ? args[idIdx + 1] : undefined;

const db = initDatabase(defaultDbPath());
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

const result = runRecover(db, { failQueued, failOpen, keepId, resetAllWorkers });

console.log("recover:");
console.log(
  `  expireLeases: requeued=${result.expired.requeued} timedOut=${result.expired.timedOut} failed=${result.expired.failed}`
);
console.log(`  DISPATCHING → FAILED: ${result.dispatchingFailed}`);
console.log(`  WAITING_APPROVAL → TIMED_OUT: ${result.waitingTimedOut}`);
if (failQueued) console.log(`  QUEUED → FAILED: ${result.queuedFailed}`);
if (failOpen) console.log(`  open (DISPATCHED/…) → FAILED: ${result.openFailed}`);
console.log(
  `  workers reset: ${result.workersReset}` +
    (resetAllWorkers ? " (--reset-all-workers)" : " (stale/dead/orphan only)")
);
console.log("open tasks:", result.openTasks.length ? result.openTasks : "(none)");
for (const row of result.openTasks) {
  console.log(`  - ${row.id}  ${row.status}  owner=${row.leaseOwner ?? "-"}`);
}
