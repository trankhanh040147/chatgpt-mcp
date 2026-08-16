import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TaskRepository } from "../tasks/task.repository.js";

export interface RecoverOptions {
  failQueued?: boolean;
  /** CLI-only for dashboard 0.3 HTTP API. */
  failOpen?: boolean;
  keepId?: string;
  /**
   * Reset every worker_state row (legacy CLI). Default false:
   * only stale/dead workers or workers whose current_task is transitioned.
   */
  resetAllWorkers?: boolean;
  /** Override stale threshold (ms). Defaults to HANDOFF_WORKER_STALE_MS or 120s. */
  staleMs?: number;
}

export interface PlannedWorkerReset {
  id: string;
  reason: "stale_hb" | "dead_pid" | "orphan_task" | "reset_all";
  instanceToken: string | null;
  currentTaskId: string | null;
}

export interface PlannedTaskAction {
  id: string;
  from: string;
  to: "FAILED" | "TIMED_OUT";
  leaseOwner: string | null;
}

export interface RecoverPlan {
  options: {
    failQueued: boolean;
    failOpen: boolean;
    keepId: string | null;
    resetAllWorkers: boolean;
  };
  now: string;
  /** expireLeases runs on execute (not previewed row-by-row). */
  willExpireLeases: true;
  dispatching: PlannedTaskAction[];
  waiting: PlannedTaskAction[];
  queued: PlannedTaskAction[];
  open: PlannedTaskAction[];
  workers: PlannedWorkerReset[];
  mutationCount: number;
  confirmPhrase: string;
  planHash: string;
}

export interface RecoverResult {
  expired: { requeued: number; timedOut: number; failed: number };
  dispatchingFailed: number;
  waitingTimedOut: number;
  queuedFailed: number;
  openFailed: number;
  workersReset: number;
  affectedTaskIds: string[];
  affectedWorkerIds: string[];
  openTasks: Array<{ id: string; status: string; leaseOwner: string | null }>;
  planHash: string;
}

export interface FailTaskResult {
  ok: boolean;
  previousStatus?: string;
  error?: string;
  code?: "not_found" | "conflict" | "bad_request" | "update_failed";
}

function staleMsFromEnv(override?: number): number {
  if (override != null && Number.isFinite(override) && override > 0) {
    return override;
  }
  const raw = Number(process.env.HANDOFF_WORKER_STALE_MS ?? 120_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM ⇒ process exists but we lack signal permission.
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    return code === "EPERM";
  }
}

function withTxn<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function listByStatus(
  db: DatabaseSync,
  statuses: string[],
  keepId?: string
): PlannedTaskAction[] {
  const placeholders = statuses.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, status, lease_owner AS leaseOwner FROM handoff_tasks
       WHERE status IN (${placeholders})
       ORDER BY created_at ASC`
    )
    .all(...statuses) as Array<{
    id: string;
    status: string;
    leaseOwner: string | null;
  }>;
  return rows
    .filter((r) => !keepId || r.id !== keepId)
    .map((r) => ({
      id: r.id,
      from: r.status,
      to: (r.status === "WAITING_APPROVAL" ? "TIMED_OUT" : "FAILED") as
        | "FAILED"
        | "TIMED_OUT",
      leaseOwner: r.leaseOwner,
    }));
}

/**
 * Read-only plan. Does not write. expireLeases still runs only on execute.
 *
 * lease_owner: keep on terminal updates for 24h attribution when the task
 * had an owner; clear for QUEUED (never claimed). Always clear lease_token /
 * lease_expires_at (capability fields).
 */
export function planRecover(
  db: DatabaseSync,
  opts: RecoverOptions = {}
): RecoverPlan {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const staleMs = staleMsFromEnv(opts.staleMs);
  const keepId = opts.keepId?.startsWith("ho_") ? opts.keepId : undefined;

  const dispatching = listByStatus(db, ["DISPATCHING"]);
  // Legacy WAITING_APPROVAL → TIMED_OUT (not failOpen).
  const waiting = listByStatus(db, ["WAITING_APPROVAL"]);
  const queued = opts.failQueued
    ? listByStatus(db, ["QUEUED"], keepId)
    : [];
  const open = opts.failOpen
    ? listByStatus(db, ["DISPATCHED", "PROCESSING"], keepId)
    : [];

  const transitioned = new Set([
    ...dispatching.map((t) => t.id),
    ...waiting.map((t) => t.id),
    ...queued.map((t) => t.id),
    ...open.map((t) => t.id),
  ]);

  const workersRaw = db
    .prepare(
      `SELECT id, status, last_seen_at AS lastSeenAt, current_task_id AS currentTaskId,
              instance_token AS instanceToken, pid
       FROM worker_state`
    )
    .all() as Array<{
    id: string;
    status: string;
    lastSeenAt: string | null;
    currentTaskId: string | null;
    instanceToken: string | null;
    pid: number | null;
  }>;

  const workers: PlannedWorkerReset[] = [];
  for (const w of workersRaw) {
    if (opts.resetAllWorkers) {
      workers.push({
        id: w.id,
        reason: "reset_all",
        instanceToken: w.instanceToken,
        currentTaskId: w.currentTaskId,
      });
      continue;
    }
    const lastSeenMs = w.lastSeenAt ? Date.parse(w.lastSeenAt) : Number.NaN;
    const hbStale =
      !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > staleMs;
    const alive = pidAlive(w.pid);
    if (w.currentTaskId && transitioned.has(w.currentTaskId)) {
      workers.push({
        id: w.id,
        reason: "orphan_task",
        instanceToken: w.instanceToken,
        currentTaskId: w.currentTaskId,
      });
      continue;
    }
    if (!alive && w.pid) {
      workers.push({
        id: w.id,
        reason: "dead_pid",
        instanceToken: w.instanceToken,
        currentTaskId: w.currentTaskId,
      });
      continue;
    }
    if (hbStale) {
      workers.push({
        id: w.id,
        reason: "stale_hb",
        instanceToken: w.instanceToken,
        currentTaskId: w.currentTaskId,
      });
    }
  }

  const taskActions = [
    ...dispatching,
    ...waiting,
    ...queued,
    ...open,
  ];
  // +1 represents expireLeases side effects (unknown count until execute).
  const mutationCount =
    taskActions.length + workers.length + 1; /* expireLeases */
  const confirmPhrase = `RECOVER ${mutationCount}`;

  const options = {
    failQueued: Boolean(opts.failQueued),
    failOpen: Boolean(opts.failOpen),
    keepId: keepId ?? null,
    resetAllWorkers: Boolean(opts.resetAllWorkers),
  };

  const planHash = createHash("sha256")
    .update(
      JSON.stringify({
        options,
        dispatching: dispatching.map((t) => t.id),
        waiting: waiting.map((t) => t.id),
        queued: queued.map((t) => t.id),
        open: open.map((t) => t.id),
        workers: workers.map((w) => ({
          id: w.id,
          reason: w.reason,
          instanceToken: w.instanceToken,
          currentTaskId: w.currentTaskId,
        })),
      })
    )
    .digest("hex");

  return {
    options,
    now,
    willExpireLeases: true,
    dispatching,
    waiting,
    queued,
    open,
    workers,
    mutationCount,
    confirmPhrase,
    planHash,
  };
}

function assertPlanFresh(db: DatabaseSync, plan: RecoverPlan): void {
  const again = planRecover(db, {
    failQueued: plan.options.failQueued,
    failOpen: plan.options.failOpen,
    keepId: plan.options.keepId ?? undefined,
    resetAllWorkers: plan.options.resetAllWorkers,
  });
  if (again.planHash !== plan.planHash) {
    const err = new Error("plan_stale");
    (err as Error & { code: string }).code = "plan_stale";
    throw err;
  }
}

/**
 * Execute a previously planned recover.
 * Re-validates planHash before mutate; task/worker writes use CAS predicates.
 * expireLeases runs in its own transaction (TaskRepository), then remaining
 * updates run in a second IMMEDIATE transaction.
 */
export function executeRecover(
  db: DatabaseSync,
  plan: RecoverPlan
): RecoverResult {
  assertPlanFresh(db, plan);
  const repo = new TaskRepository(db);
  const now = new Date().toISOString();
  const expired = repo.expireLeases(now);

  return withTxn(db, () => {
    let dispatchingFailed = 0;
    for (const t of plan.dispatching) {
      dispatchingFailed += Number(
        db
          .prepare(
            `UPDATE handoff_tasks
             SET status = 'FAILED',
                 error = 'Recovered: stuck DISPATCHING (ops recover)',
                 completed_at = COALESCE(completed_at, ?),
                 lease_token = NULL, lease_expires_at = NULL
             WHERE id = ? AND status = 'DISPATCHING'`
          )
          .run(now, t.id).changes ?? 0
      );
    }

    let waitingTimedOut = 0;
    for (const t of plan.waiting) {
      waitingTimedOut += Number(
        db
          .prepare(
            `UPDATE handoff_tasks
             SET status = 'TIMED_OUT',
                 error = 'Recovered: legacy WAITING_APPROVAL (ops recover)',
                 completed_at = COALESCE(completed_at, ?),
                 lease_token = NULL, lease_expires_at = NULL
             WHERE id = ? AND status = 'WAITING_APPROVAL'`
          )
          .run(now, t.id).changes ?? 0
      );
    }

    let queuedFailed = 0;
    for (const t of plan.queued) {
      // QUEUED never claimed — clear owner.
      queuedFailed += Number(
        db
          .prepare(
            `UPDATE handoff_tasks
             SET status = 'FAILED',
                 error = 'Recovered: superseded QUEUED (ops recover)',
                 completed_at = COALESCE(completed_at, ?),
                 lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
             WHERE id = ? AND status = 'QUEUED'`
          )
          .run(now, t.id).changes ?? 0
      );
    }

    let openFailed = 0;
    for (const t of plan.open) {
      openFailed += Number(
        db
          .prepare(
            `UPDATE handoff_tasks
             SET status = 'FAILED',
                 error = 'Recovered: superseded open task (ops recover)',
                 completed_at = COALESCE(completed_at, ?),
                 lease_token = NULL, lease_expires_at = NULL
             WHERE id = ? AND status IN ('DISPATCHED','PROCESSING')`
          )
          .run(now, t.id).changes ?? 0
      );
    }

    let workersReset = 0;
    const affectedWorkerIds: string[] = [];
    for (const w of plan.workers) {
      const info = db
        .prepare(
          `UPDATE worker_state
           SET status = 'READY',
               current_task_id = NULL,
               error = NULL,
               last_seen_at = ?,
               instance_token = NULL,
               pid = NULL
           WHERE id = ?
             AND ((? IS NULL AND instance_token IS NULL) OR instance_token = ?)
             AND ((? IS NULL AND current_task_id IS NULL) OR current_task_id = ?)`
        )
        .run(
          now,
          w.id,
          w.instanceToken,
          w.instanceToken,
          w.currentTaskId,
          w.currentTaskId
        );
      const n = Number(info.changes ?? 0);
      if (n === 1) {
        workersReset += 1;
        affectedWorkerIds.push(w.id);
      }
    }

    const affectedTaskIds = [
      ...plan.dispatching.map((t) => t.id),
      ...plan.waiting.map((t) => t.id),
      ...plan.queued.map((t) => t.id),
      ...plan.open.map((t) => t.id),
    ];

    const openTasks = (
      db
        .prepare(
          `SELECT id, status, lease_owner AS leaseOwner FROM handoff_tasks
           WHERE status IN ('QUEUED','DISPATCHING','DISPATCHED','PROCESSING','WAITING_APPROVAL')
           ORDER BY created_at ASC`
        )
        .all() as Array<{ id: string; status: string; leaseOwner: string | null }>
    ).map((r) => ({
      id: r.id,
      status: r.status,
      leaseOwner: r.leaseOwner,
    }));

    return {
      expired,
      dispatchingFailed,
      waitingTimedOut,
      queuedFailed,
      openFailed,
      workersReset,
      affectedTaskIds,
      affectedWorkerIds,
      openTasks,
      planHash: plan.planHash,
    };
  });
}

/** Convenience: plan + execute (CLI). */
export function runRecover(
  db: DatabaseSync,
  opts: RecoverOptions = {}
): RecoverResult {
  const plan = planRecover(db, opts);
  return executeRecover(db, plan);
}

export function failTaskById(
  db: DatabaseSync,
  taskId: string,
  reason = "Failed from ops dashboard"
): FailTaskResult {
  const id = taskId.trim();
  if (!id.startsWith("ho_") || id.length > 128) {
    return {
      ok: false,
      code: "bad_request",
      error: "taskId must be ho_… (≤128)",
    };
  }
  const msg = reason.trim().slice(0, 500) || "Failed from ops dashboard";

  return withTxn(db, () => {
    const row = db
      .prepare(`SELECT status FROM handoff_tasks WHERE id = ?`)
      .get(id) as { status: string } | undefined;
    if (!row) {
      return { ok: false, code: "not_found", error: `Task not found: ${id}` };
    }
    if (
      row.status === "COMPLETED" ||
      row.status === "FAILED" ||
      row.status === "CANCELLED" ||
      row.status === "TIMED_OUT"
    ) {
      return {
        ok: false,
        code: "conflict",
        error: `Task already terminal: ${row.status}`,
        previousStatus: row.status,
      };
    }
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `UPDATE handoff_tasks
         SET status = 'FAILED',
             error = ?,
             completed_at = COALESCE(completed_at, ?),
             lease_token = NULL, lease_expires_at = NULL
         WHERE id = ? AND status = ?`
      )
      .run(msg, now, id, row.status);
    if (Number(info.changes ?? 0) !== 1) {
      return {
        ok: false,
        code: "conflict",
        error: "Task state changed during fail",
        previousStatus: row.status,
      };
    }
    db.prepare(
      `UPDATE worker_state
       SET current_task_id = NULL, last_seen_at = ?
       WHERE current_task_id = ?`
    ).run(now, id);
    return { ok: true, previousStatus: row.status };
  });
}

export function newOpsToken(): string {
  return randomBytes(32).toString("hex");
}

export function redactCdpEndpoint(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "(redacted)";
  }
}
