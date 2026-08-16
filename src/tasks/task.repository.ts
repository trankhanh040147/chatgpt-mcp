import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import type {
  ClaimResult,
  HandoffTask,
  HandoffTaskContext,
  HandoffResultMetadata,
  HandoffTaskStatus,
  WorkerStateRow,
  WorkerStatus,
} from "../tasks/task.types.js";
import { DEFAULT_WORKER_ID } from "../tasks/task.types.js";

type SqlParam = string | number | bigint | null;

interface TaskRow {
  id: string;
  cursor_conversation_id: string;
  type: string;
  prompt: string;
  context_json: string | null;
  status: string;
  result: string | null;
  result_metadata_json: string | null;
  retry_count: number;
  created_at: string;
  dispatched_at: string | null;
  processing_at: string | null;
  completed_at: string | null;
  error: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  dispatch_started_at: string | null;
  dispatch_attempt: number | null;
  nudge_started_at: string | null;
  nudge_attempt: number | null;
}

interface WorkerRow {
  id: string;
  status: string;
  last_seen_at: string | null;
  current_task_id: string | null;
  error: string | null;
  instance_token: string | null;
  worker_url: string | null;
  cdp_endpoint: string | null;
  http_port: number | null;
  started_at: string | null;
  pid: number | null;
}

const MAX_DISPATCH_RETRIES = 3;

function rowToTask(row: TaskRow): HandoffTask {
  return {
    id: row.id,
    cursorConversationId: row.cursor_conversation_id,
    type: row.type as HandoffTask["type"],
    prompt: row.prompt,
    context: row.context_json
      ? (JSON.parse(row.context_json) as HandoffTaskContext)
      : undefined,
    status: row.status as HandoffTaskStatus,
    result: row.result ?? undefined,
    resultMetadata: row.result_metadata_json
      ? (JSON.parse(row.result_metadata_json) as HandoffResultMetadata)
      : undefined,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at ?? undefined,
    processingAt: row.processing_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseToken: row.lease_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    dispatchStartedAt: row.dispatch_started_at ?? undefined,
    dispatchAttempt: row.dispatch_attempt ?? 0,
    nudgeStartedAt: row.nudge_started_at ?? undefined,
    nudgeAttempt: row.nudge_attempt ?? 0,
  };
}

function rowToWorker(row: WorkerRow): WorkerStateRow {
  return {
    id: row.id,
    status: row.status as WorkerStatus,
    lastSeenAt: row.last_seen_at ?? undefined,
    currentTaskId: row.current_task_id ?? undefined,
    error: row.error ?? undefined,
    instanceToken: row.instance_token ?? undefined,
    workerUrl: row.worker_url ?? undefined,
    cdpEndpoint: row.cdp_endpoint ?? undefined,
    httpPort: row.http_port ?? undefined,
    startedAt: row.started_at ?? undefined,
    pid: row.pid ?? undefined,
  };
}

function clearLeaseSets(): string {
  return `lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL`;
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (pid == null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertTask(task: HandoffTask): void {
    this.db
      .prepare(
        `INSERT INTO handoff_tasks (
          id, cursor_conversation_id, type, prompt, context_json,
          status, retry_count, created_at,
          dispatch_attempt, nudge_attempt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.cursorConversationId,
        task.type,
        task.prompt,
        task.context ? JSON.stringify(task.context) : null,
        task.status,
        task.retryCount,
        task.createdAt,
        task.dispatchAttempt ?? 0,
        task.nudgeAttempt ?? 0
      );
  }

  getTaskById(id: string): HandoffTask | null {
    const row = this.db
      .prepare("SELECT * FROM handoff_tasks WHERE id = ?")
      .get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  updateTaskStatus(
    id: string,
    status: HandoffTaskStatus,
    extra: Partial<{
      dispatchedAt: string;
      processingAt: string;
      completedAt: string;
      error: string;
      retryCount: number;
      clearLease: boolean;
    }> = {}
  ): void {
    const sets = ["status = ?"];
    const values: SqlParam[] = [status];

    if (extra.dispatchedAt !== undefined) {
      sets.push("dispatched_at = ?");
      values.push(extra.dispatchedAt);
    }
    if (extra.processingAt !== undefined) {
      sets.push("processing_at = ?");
      values.push(extra.processingAt);
    }
    if (extra.completedAt !== undefined) {
      sets.push("completed_at = ?");
      values.push(extra.completedAt);
    }
    if (extra.error !== undefined) {
      sets.push("error = ?");
      values.push(extra.error);
    }
    if (extra.retryCount !== undefined) {
      sets.push("retry_count = ?");
      values.push(extra.retryCount);
    }
    if (extra.clearLease) {
      sets.push(clearLeaseSets());
    }

    values.push(id);
    this.db
      .prepare(`UPDATE handoff_tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  /**
   * First completion only. Requires durable dispatch marker.
   * Clears lease_owner in the same update (partial unique index).
   */
  saveResultIfOpen(
    id: string,
    result: string,
    metadata?: HandoffResultMetadata
  ): number {
    const info = this.db
      .prepare(
        `UPDATE handoff_tasks
         SET status = ?, result = ?, result_metadata_json = ?, completed_at = ?,
             ${clearLeaseSets()}
         WHERE id = ?
           AND status IN ('DISPATCHED', 'PROCESSING', 'WAITING_APPROVAL')
           AND dispatch_started_at IS NOT NULL
           AND result IS NULL`
      )
      .run(
        "COMPLETED",
        result,
        metadata ? JSON.stringify(metadata) : null,
        new Date().toISOString(),
        id
      );
    return Number(info.changes ?? 0);
  }

  /** @deprecated Prefer saveResultIfOpen for concurrent-safe completion. */
  saveResult(
    id: string,
    result: string,
    metadata?: HandoffResultMetadata
  ): void {
    this.saveResultIfOpen(id, result, metadata);
  }

  findPendingByConversation(conversationId: string): HandoffTask | null {
    const row = this.db
      .prepare(
        `SELECT * FROM handoff_tasks
         WHERE cursor_conversation_id = ?
           AND status IN ('QUEUED', 'DISPATCHING', 'DISPATCHED', 'PROCESSING', 'RATE_LIMITED')
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(conversationId) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  findCompletedByConversation(conversationId: string): HandoffTask | null {
    const row = this.db
      .prepare(
        `SELECT * FROM handoff_tasks
         WHERE cursor_conversation_id = ?
           AND status = 'COMPLETED'
         ORDER BY completed_at DESC
         LIMIT 1`
      )
      .get(conversationId) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  /**
   * Claim oldest QUEUED under lease. Verifies live worker incarnation.
   * Must commit before any browser work.
   */
  claimNextQueued(
    workerId: string,
    instanceToken: string,
    leaseMs: number,
    workerStaleMs: number
  ): ClaimResult | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const staleCutoff = new Date(now - workerStaleMs).toISOString();
      const expiresIso = new Date(now + leaseMs).toISOString();

      const worker = this.db
        .prepare(
          `SELECT * FROM worker_state
           WHERE id = ?
             AND instance_token = ?
             AND last_seen_at IS NOT NULL
             AND last_seen_at > ?`
        )
        .get(workerId, instanceToken, staleCutoff) as WorkerRow | undefined;

      if (!worker) {
        this.db.exec("COMMIT");
        return null;
      }

      const active = this.db
        .prepare(
          `SELECT id FROM handoff_tasks
           WHERE lease_owner = ?
             AND status IN ('DISPATCHING','DISPATCHED','PROCESSING','WAITING_APPROVAL')
           LIMIT 1`
        )
        .get(workerId) as { id: string } | undefined;
      if (active) {
        this.db.exec("COMMIT");
        return null;
      }

      const row = this.db
        .prepare(
          `SELECT * FROM handoff_tasks
           WHERE status = 'QUEUED'
           ORDER BY created_at ASC
           LIMIT 1`
        )
        .get() as TaskRow | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      const leaseToken = ulid();
      const updated = this.db
        .prepare(
          `UPDATE handoff_tasks
           SET status = 'DISPATCHING',
               lease_owner = ?,
               lease_token = ?,
               lease_expires_at = ?,
               dispatch_started_at = NULL,
               dispatch_attempt = 0,
               nudge_started_at = NULL,
               nudge_attempt = 0
           WHERE id = ? AND status = 'QUEUED'`
        )
        .run(workerId, leaseToken, expiresIso, row.id);

      if (updated.changes === 0) {
        this.db.exec("COMMIT");
        return null;
      }

      this.db
        .prepare(
          `UPDATE worker_state
           SET current_task_id = ?, last_seen_at = ?
           WHERE id = ? AND instance_token = ?`
        )
        .run(row.id, nowIso, workerId, instanceToken);

      this.db.exec("COMMIT");
      return {
        leaseToken,
        task: rowToTask({
          ...row,
          status: "DISPATCHING",
          lease_owner: workerId,
          lease_token: leaseToken,
          lease_expires_at: expiresIso,
          dispatch_started_at: null,
          dispatch_attempt: 0,
          nudge_started_at: null,
          nudge_attempt: 0,
        }),
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** @deprecated Use claimNextQueued(workerId, instanceToken, leaseMs, …) */
  claimOldestQueued(): HandoffTask | null {
    const claimed = this.claimNextQueued(
      DEFAULT_WORKER_ID,
      "legacy",
      30_000,
      120_000
    );
    return claimed?.task ?? null;
  }

  renewLease(
    taskId: string,
    workerId: string,
    leaseToken: string,
    instanceToken: string,
    leaseMs: number,
    workerStaleMs: number
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const staleCutoff = new Date(now - workerStaleMs).toISOString();
      const expiresIso = new Date(now + leaseMs).toISOString();

      const info = this.db
        .prepare(
          `UPDATE handoff_tasks
           SET lease_expires_at = ?
           WHERE id = ?
             AND lease_owner = ?
             AND lease_token = ?
             AND lease_expires_at > ?
             AND status IN ('DISPATCHING','DISPATCHED','PROCESSING','WAITING_APPROVAL')
             AND EXISTS (
               SELECT 1 FROM worker_state ws
               WHERE ws.id = ?
                 AND ws.instance_token = ?
                 AND ws.last_seen_at IS NOT NULL
                 AND ws.last_seen_at > ?
             )`
        )
        .run(
          expiresIso,
          taskId,
          workerId,
          leaseToken,
          nowIso,
          workerId,
          instanceToken,
          staleCutoff
        );

      if (info.changes === 1) {
        this.db
          .prepare(
            `UPDATE worker_state SET last_seen_at = ?
             WHERE id = ? AND instance_token = ?`
          )
          .run(nowIso, workerId, instanceToken);
      }

      this.db.exec("COMMIT");
      return Number(info.changes ?? 0) === 1;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Irreversible dispatch fence: DISPATCHING → DISPATCHED + marker before UI send.
   */
  markDispatchStarted(
    taskId: string,
    workerId: string,
    leaseToken: string,
    instanceToken: string,
    leaseMs: number,
    workerStaleMs: number
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const staleCutoff = new Date(now - workerStaleMs).toISOString();
      const expiresIso = new Date(now + leaseMs).toISOString();

      const info = this.db
        .prepare(
          `UPDATE handoff_tasks
           SET status = 'DISPATCHED',
               dispatched_at = ?,
               dispatch_started_at = ?,
               dispatch_attempt = 1,
               lease_expires_at = ?
           WHERE id = ?
             AND status = 'DISPATCHING'
             AND lease_owner = ?
             AND lease_token = ?
             AND lease_expires_at > ?
             AND dispatch_started_at IS NULL
             AND dispatch_attempt = 0
             AND EXISTS (
               SELECT 1 FROM worker_state ws
               WHERE ws.id = ?
                 AND ws.instance_token = ?
                 AND ws.last_seen_at IS NOT NULL
                 AND ws.last_seen_at > ?
             )`
        )
        .run(
          nowIso,
          nowIso,
          expiresIso,
          taskId,
          workerId,
          leaseToken,
          nowIso,
          workerId,
          instanceToken,
          staleCutoff
        );

      if (info.changes === 1) {
        this.db
          .prepare(
            `UPDATE worker_state SET last_seen_at = ?
             WHERE id = ? AND instance_token = ?`
          )
          .run(nowIso, workerId, instanceToken);
      }

      this.db.exec("COMMIT");
      return Number(info.changes ?? 0) === 1;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** At most one nudge in 0.2.0. Fence before chat write. */
  markNudgeStarted(
    taskId: string,
    workerId: string,
    leaseToken: string,
    instanceToken: string,
    leaseMs: number,
    workerStaleMs: number
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const staleCutoff = new Date(now - workerStaleMs).toISOString();
      const expiresIso = new Date(now + leaseMs).toISOString();

      // Promote to open-approval state first (same txn) so nudge CAS can
      // require status = WAITING_APPROVAL + unexpired lease.
      this.db
        .prepare(
          `UPDATE handoff_tasks
           SET status = 'WAITING_APPROVAL',
               lease_expires_at = ?
           WHERE id = ?
             AND status IN ('DISPATCHED', 'PROCESSING')
             AND lease_owner = ?
             AND lease_token = ?
             AND lease_expires_at > ?
             AND dispatch_started_at IS NOT NULL
             AND dispatch_attempt = 1
             AND EXISTS (
               SELECT 1 FROM worker_state ws
               WHERE ws.id = ?
                 AND ws.instance_token = ?
                 AND ws.last_seen_at IS NOT NULL
                 AND ws.last_seen_at > ?
             )`
        )
        .run(
          expiresIso,
          taskId,
          workerId,
          leaseToken,
          nowIso,
          workerId,
          instanceToken,
          staleCutoff
        );

      const info = this.db
        .prepare(
          `UPDATE handoff_tasks
           SET nudge_started_at = ?,
               nudge_attempt = 1,
               lease_expires_at = ?
           WHERE id = ?
             AND status = 'WAITING_APPROVAL'
             AND lease_owner = ?
             AND lease_token = ?
             AND lease_expires_at > ?
             AND dispatch_started_at IS NOT NULL
             AND dispatch_attempt = 1
             AND nudge_attempt = 0
             AND nudge_started_at IS NULL
             AND EXISTS (
               SELECT 1 FROM worker_state ws
               WHERE ws.id = ?
                 AND ws.instance_token = ?
                 AND ws.last_seen_at IS NOT NULL
                 AND ws.last_seen_at > ?
             )`
        )
        .run(
          nowIso,
          expiresIso,
          taskId,
          workerId,
          leaseToken,
          nowIso,
          workerId,
          instanceToken,
          staleCutoff
        );

      if (info.changes === 1) {
        this.db
          .prepare(
            `UPDATE worker_state SET last_seen_at = ?
             WHERE id = ? AND instance_token = ?`
          )
          .run(nowIso, workerId, instanceToken);
      }

      this.db.exec("COMMIT");
      return Number(info.changes ?? 0) === 1;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Status-api reaper. DISPATCHING without marker → requeue/fail;
   * post-marker active → TIMED_OUT.
   */
  expireLeases(nowIso = new Date().toISOString()): {
    requeued: number;
    timedOut: number;
    failed: number;
  } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let requeued = 0;
      let timedOut = 0;
      let failed = 0;

      const clearDiagForTask = this.db.prepare(
        `UPDATE worker_state
         SET current_task_id = NULL
         WHERE current_task_id = ?`
      );

      const preDispatch = this.db
        .prepare(
          `SELECT id, retry_count FROM handoff_tasks
           WHERE status = 'DISPATCHING'
             AND dispatch_started_at IS NULL
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < ?`
        )
        .all(nowIso) as Array<{ id: string; retry_count: number }>;

      for (const row of preDispatch) {
        const retryCount = row.retry_count + 1;
        let changed = 0;
        if (retryCount < MAX_DISPATCH_RETRIES) {
          const info = this.db
            .prepare(
              `UPDATE handoff_tasks
               SET status = 'QUEUED',
                   retry_count = ?,
                   error = 'Lease expired before dispatch fence',
                   ${clearLeaseSets()}
               WHERE id = ? AND status = 'DISPATCHING' AND dispatch_started_at IS NULL`
            )
            .run(retryCount, row.id);
          changed = Number(info.changes ?? 0);
          if (changed === 1) requeued += 1;
        } else {
          const info = this.db
            .prepare(
              `UPDATE handoff_tasks
               SET status = 'FAILED',
                   retry_count = ?,
                   error = 'Lease expired before dispatch fence (max retries)',
                   ${clearLeaseSets()}
               WHERE id = ? AND status = 'DISPATCHING' AND dispatch_started_at IS NULL`
            )
            .run(retryCount, row.id);
          changed = Number(info.changes ?? 0);
          if (changed === 1) failed += 1;
        }
        // Diagnostic clear only when this expiry transition won.
        if (changed === 1) clearDiagForTask.run(row.id);
      }

      const postRows = this.db
        .prepare(
          `SELECT id FROM handoff_tasks
           WHERE status IN ('DISPATCHED','PROCESSING','WAITING_APPROVAL')
             AND dispatch_started_at IS NOT NULL
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < ?`
        )
        .all(nowIso) as Array<{ id: string }>;

      for (const row of postRows) {
        const info = this.db
          .prepare(
            `UPDATE handoff_tasks
             SET status = 'TIMED_OUT',
                 error = COALESCE(error, 'Lease expired after dispatch fence'),
                 completed_at = COALESCE(completed_at, ?),
                 ${clearLeaseSets()}
             WHERE id = ?
               AND status IN ('DISPATCHED','PROCESSING','WAITING_APPROVAL')
               AND dispatch_started_at IS NOT NULL
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at < ?`
          )
          .run(nowIso, row.id, nowIso);
        if (Number(info.changes ?? 0) === 1) {
          timedOut += 1;
          clearDiagForTask.run(row.id);
        }
      }

      // Stale DISPATCHING with marker (should be rare) → TIMED_OUT
      const weirdRows = this.db
        .prepare(
          `SELECT id FROM handoff_tasks
           WHERE status = 'DISPATCHING'
             AND dispatch_started_at IS NOT NULL
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < ?`
        )
        .all(nowIso) as Array<{ id: string }>;

      for (const row of weirdRows) {
        const info = this.db
          .prepare(
            `UPDATE handoff_tasks
             SET status = 'TIMED_OUT',
                 error = COALESCE(error, 'Lease expired (DISPATCHING with marker)'),
                 completed_at = COALESCE(completed_at, ?),
                 ${clearLeaseSets()}
             WHERE id = ?
               AND status = 'DISPATCHING'
               AND dispatch_started_at IS NOT NULL
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at < ?`
          )
          .run(nowIso, row.id, nowIso);
        if (Number(info.changes ?? 0) === 1) {
          timedOut += 1;
          clearDiagForTask.run(row.id);
        }
      }

      this.db.exec("COMMIT");
      return { requeued, timedOut, failed };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  releasePreDispatchClaim(
    taskId: string,
    workerId: string,
    leaseToken: string,
    instanceToken: string,
    error: string
  ): "requeued" | "failed" | "noop" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM handoff_tasks
           WHERE id = ?
             AND status = 'DISPATCHING'
             AND dispatch_started_at IS NULL
             AND lease_owner = ?
             AND lease_token = ?`
        )
        .get(taskId, workerId, leaseToken) as TaskRow | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return "noop";
      }

      const retryCount = row.retry_count + 1;
      if (retryCount < MAX_DISPATCH_RETRIES) {
        this.db
          .prepare(
            `UPDATE handoff_tasks
             SET status = 'QUEUED', retry_count = ?, error = ?, ${clearLeaseSets()}
             WHERE id = ?`
          )
          .run(retryCount, error, taskId);
        this.db
          .prepare(
            `UPDATE worker_state
             SET current_task_id = NULL, last_seen_at = ?
             WHERE id = ? AND instance_token = ?`
          )
          .run(new Date().toISOString(), workerId, instanceToken);
        this.db.exec("COMMIT");
        return "requeued";
      }

      this.db
        .prepare(
          `UPDATE handoff_tasks
           SET status = 'FAILED', retry_count = ?, error = ?, ${clearLeaseSets()}
           WHERE id = ?`
        )
        .run(retryCount, error, taskId);
      this.db
        .prepare(
          `UPDATE worker_state
           SET current_task_id = NULL, last_seen_at = ?
           WHERE id = ? AND instance_token = ?`
        )
        .run(new Date().toISOString(), workerId, instanceToken);
      this.db.exec("COMMIT");
      return "failed";
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  clearWorkerCurrentTask(
    workerId: string,
    instanceToken: string,
    taskId?: string
  ): void {
    const now = new Date().toISOString();
    if (taskId) {
      this.db
        .prepare(
          `UPDATE worker_state
           SET current_task_id = NULL, last_seen_at = ?
           WHERE id = ? AND instance_token = ?
             AND (current_task_id IS NULL OR current_task_id = ?)`
        )
        .run(now, workerId, instanceToken, taskId);
    } else {
      this.db
        .prepare(
          `UPDATE worker_state
           SET current_task_id = NULL, last_seen_at = ?
           WHERE id = ? AND instance_token = ?`
        )
        .run(now, workerId, instanceToken);
    }
  }

  listWorkers(): WorkerStateRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM worker_state ORDER BY id ASC`)
      .all() as unknown as WorkerRow[];
    return rows.map(rowToWorker);
  }

  /**
   * Register / take over worker incarnation.
   * Fails only if another live PID still holds the id within heartbeat window.
   */
  registerWorkerInstance(input: {
    workerId: string;
    instanceToken: string;
    workerUrl: string;
    cdpEndpoint: string;
    httpPort?: number | null;
    staleMs: number;
    pid?: number;
  }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const staleCutoff = new Date(Date.now() - input.staleMs).toISOString();
      const pid = input.pid ?? process.pid;
      const existing = this.db
        .prepare(`SELECT * FROM worker_state WHERE id = ?`)
        .get(input.workerId) as WorkerRow | undefined;

      if (existing?.instance_token && existing.instance_token !== input.instanceToken) {
        const heartbeatFresh =
          existing.last_seen_at && existing.last_seen_at > staleCutoff;
        const otherAlive = isPidAlive(existing.pid);
        if (heartbeatFresh && otherAlive) {
          this.db.exec("ROLLBACK");
          throw new Error(
            `Worker id "${input.workerId}" is already live (pid ${existing.pid}, instance ${existing.instance_token.slice(0, 8)}…). ` +
              `Stop the other process or wait for heartbeat expiry.`
          );
        }
      }

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO worker_state (
               id, status, last_seen_at, current_task_id, error,
               instance_token, worker_url, cdp_endpoint, http_port, started_at, pid
             ) VALUES (?, 'STARTING', ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.workerId,
            now,
            input.instanceToken,
            input.workerUrl,
            input.cdpEndpoint,
            input.httpPort ?? null,
            now,
            pid
          );
      } else {
        this.db
          .prepare(
            `UPDATE worker_state
             SET status = 'STARTING',
                 last_seen_at = ?,
                 current_task_id = NULL,
                 error = NULL,
                 instance_token = ?,
                 worker_url = ?,
                 cdp_endpoint = ?,
                 http_port = ?,
                 started_at = ?,
                 pid = ?
             WHERE id = ?`
          )
          .run(
            now,
            input.instanceToken,
            input.workerUrl,
            input.cdpEndpoint,
            input.httpPort ?? null,
            now,
            pid,
            input.workerId
          );
      }

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** Mark instance offline so a restart can take over immediately. */
  releaseWorkerInstance(workerId: string, instanceToken: string): void {
    const past = new Date(0).toISOString();
    this.db
      .prepare(
        `UPDATE worker_state
         SET status = 'READY',
             current_task_id = NULL,
             last_seen_at = ?,
             instance_token = NULL,
             pid = NULL,
             error = NULL
         WHERE id = ? AND instance_token = ?`
      )
      .run(past, workerId, instanceToken);
  }

  touchWorkerHeartbeat(workerId: string, instanceToken: string): boolean {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE worker_state SET last_seen_at = ?
         WHERE id = ? AND instance_token = ?`
      )
      .run(now, workerId, instanceToken);
    return Number(info.changes ?? 0) === 1;
  }

  getWorkerState(workerId = DEFAULT_WORKER_ID): WorkerStateRow {
    const row = this.db
      .prepare("SELECT * FROM worker_state WHERE id = ?")
      .get(workerId) as WorkerRow | undefined;

    if (!row) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO worker_state (id, status, last_seen_at, started_at)
           VALUES (?, 'STARTING', ?, ?)`
        )
        .run(workerId, now, now);
      return { id: workerId, status: "STARTING", lastSeenAt: now, startedAt: now };
    }

    return rowToWorker(row);
  }

  updateWorkerState(
    workerId: string,
    status: WorkerStatus,
    extra: Partial<{
      currentTaskId: string | null;
      error: string | null;
      instanceToken?: string;
    }> = {}
  ): void {
    const existing = this.db
      .prepare("SELECT id, instance_token FROM worker_state WHERE id = ?")
      .get(workerId) as { id: string; instance_token: string | null } | undefined;

    const now = new Date().toISOString();

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO worker_state (
             id, status, last_seen_at, current_task_id, error, instance_token, started_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          workerId,
          status,
          now,
          extra.currentTaskId ?? null,
          extra.error ?? null,
          extra.instanceToken ?? null,
          now
        );
      return;
    }

    if (
      extra.instanceToken &&
      existing.instance_token &&
      existing.instance_token !== extra.instanceToken
    ) {
      throw new Error(
        `Refusing worker_state update for ${workerId}: instance_token mismatch`
      );
    }

    const sets = ["status = ?", "last_seen_at = ?"];
    const values: SqlParam[] = [status, now];

    if ("currentTaskId" in extra) {
      sets.push("current_task_id = ?");
      values.push(extra.currentTaskId ?? null);
    }
    if ("error" in extra) {
      sets.push("error = ?");
      values.push(extra.error ?? null);
    }

    if (extra.instanceToken) {
      values.push(workerId, extra.instanceToken);
      this.db
        .prepare(
          `UPDATE worker_state SET ${sets.join(", ")} WHERE id = ? AND instance_token = ?`
        )
        .run(...values);
      return;
    }

    values.push(workerId);
    this.db
      .prepare(`UPDATE worker_state SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  findStaleDispatched(beforeIso: string): HandoffTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM handoff_tasks
         WHERE status = 'DISPATCHED'
           AND dispatched_at IS NOT NULL
           AND dispatched_at < ?`
      )
      .all(beforeIso) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  findStaleOpenTasks(beforeIso: string): HandoffTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM handoff_tasks
         WHERE (
           (status = 'DISPATCHED' AND dispatched_at IS NOT NULL AND dispatched_at < ?)
           OR (status = 'PROCESSING' AND processing_at IS NOT NULL AND processing_at < ?)
         )`
      )
      .all(beforeIso, beforeIso) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  findLegacyWaitingApproval(): HandoffTask[] {
    const rows = this.db
      .prepare(`SELECT * FROM handoff_tasks WHERE status = 'WAITING_APPROVAL'`)
      .all() as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Mid-claim crash: status DISPATCHING but no dispatch marker. */
  findStuckDispatching(beforeIso: string): HandoffTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM handoff_tasks
         WHERE status = 'DISPATCHING'
           AND dispatch_started_at IS NULL
           AND created_at < ?`
      )
      .all(beforeIso) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }
}
