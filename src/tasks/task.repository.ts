import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import type {
  ClaimResult,
  HandoffTask,
  HandoffTaskContext,
  HandoffTaskFile,
  HandoffResultMetadata,
  HandoffTaskStatus,
  WorkerStateRow,
  WorkerStatus,
} from "../tasks/task.types.js";
import { DEFAULT_WORKER_ID } from "../tasks/task.types.js";
import {
  isChatBudgetExhausted,
  parseMaxTasksPerChat,
  readinessBlocksClaim,
  type WorkerReadinessReason,
} from "../workers/chat-budget.js";

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
  workspace_root: string | null;
  task_class: string | null;
  target_worker_id: string | null;
}

interface TaskFileRow {
  task_id: string;
  file_id: string;
  display_name: string;
  relative_path: string;
  source_path: string;
  size_bytes: number;
  sha256: string;
  media_type: string;
  created_at: string;
}

function rowToTaskFile(row: TaskFileRow): HandoffTaskFile {
  return {
    fileId: row.file_id,
    displayName: row.display_name,
    relativePath: row.relative_path,
    snapshotPath: row.source_path,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    mediaType: row.media_type,
    createdAt: row.created_at,
  };
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
  tasks_on_chat: number | null;
  tasks_on_chat_url: string | null;
  previous_worker_url: string | null;
  chat_rotated_at: string | null;
  readiness_reason: string | null;
  mcp_read_verified_at: string | null;
  mcp_write_verified_at: string | null;
  mcp_write_status: string | null;
  mcp_write_status_reason: string | null;
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
    workspaceRoot: row.workspace_root ?? undefined,
    taskClass: (row.task_class as HandoffTask["taskClass"]) ?? "USER",
    targetWorkerId: row.target_worker_id ?? undefined,
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
    tasksOnChat: row.tasks_on_chat ?? 0,
    tasksOnChatUrl: row.tasks_on_chat_url ?? undefined,
    previousWorkerUrl: row.previous_worker_url ?? undefined,
    chatRotatedAt: row.chat_rotated_at ?? undefined,
    readinessReason: (row.readiness_reason as WorkerStateRow["readinessReason"]) ??
      undefined,
    mcpReadVerifiedAt: row.mcp_read_verified_at ?? undefined,
    mcpWriteVerifiedAt: row.mcp_write_verified_at ?? undefined,
    mcpWriteStatus: (row.mcp_write_status as WorkerStateRow["mcpWriteStatus"]) ??
      undefined,
    mcpWriteStatusReason: row.mcp_write_status_reason ?? undefined,
  };
}

/** Drop lease auth fields but keep lease_owner for ops attribution on terminal rows. */
function clearLeaseAuthSets(): string {
  return `lease_token = NULL, lease_expires_at = NULL`;
}

/** Full lease release (required when returning to QUEUED / free claim). */
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
    this.insertTaskWithFiles(task, []);
  }

  /** Validate-all-then-insert: task row + all file rows in one transaction. */
  insertTaskWithFiles(task: HandoffTask, files: HandoffTaskFile[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO handoff_tasks (
            id, cursor_conversation_id, type, prompt, context_json,
            status, retry_count, created_at,
            dispatch_attempt, nudge_attempt, workspace_root,
            task_class, target_worker_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          task.nudgeAttempt ?? 0,
          task.workspaceRoot ?? null,
          task.taskClass ?? "USER",
          task.targetWorkerId ?? null
        );

      const insertFile = this.db.prepare(
        `INSERT INTO handoff_task_files (
          task_id, file_id, display_name, relative_path, source_path,
          size_bytes, sha256, media_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const f of files) {
        insertFile.run(
          task.id,
          f.fileId,
          f.displayName,
          f.relativePath,
          f.snapshotPath,
          f.sizeBytes,
          f.sha256,
          f.mediaType,
          f.createdAt
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getTaskById(id: string): HandoffTask | null {
    const row = this.db
      .prepare("SELECT * FROM handoff_tasks WHERE id = ?")
      .get(id) as TaskRow | undefined;
    if (!row) return null;
    const task = rowToTask(row);
    const fileRows = this.db
      .prepare("SELECT * FROM handoff_task_files WHERE task_id = ?")
      .all(id) as unknown as TaskFileRow[];
    task.files = fileRows.map(rowToTaskFile);
    return task;
  }

  /** Server-side probe token (never sent to ChatGPT in get_task). */
  setProbeToken(taskId: string, token: string): void {
    const row = this.db
      .prepare(`SELECT context_json FROM handoff_tasks WHERE id = ?`)
      .get(taskId) as { context_json: string | null } | undefined;
    if (!row) return;
    const ctx = row.context_json
      ? (JSON.parse(row.context_json) as Record<string, unknown>)
      : {};
    ctx._probeToken = token;
    this.db
      .prepare(`UPDATE handoff_tasks SET context_json = ? WHERE id = ?`)
      .run(JSON.stringify(ctx), taskId);
  }

  getProbeToken(taskId: string): string | null {
    const row = this.db
      .prepare(`SELECT context_json FROM handoff_tasks WHERE id = ?`)
      .get(taskId) as { context_json: string | null } | undefined;
    if (!row?.context_json) return null;
    const ctx = JSON.parse(row.context_json) as { _probeToken?: string };
    return ctx._probeToken ?? null;
  }

  findPendingConnectorHandshake(workerId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM handoff_tasks
         WHERE target_worker_id = ?
           AND status IN (
             'QUEUED', 'DISPATCHING', 'DISPATCHED', 'PROCESSING', 'WAITING_APPROVAL'
           )
           AND prompt LIKE 'Connector handshake%'
         LIMIT 1`
      )
      .get(workerId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Frozen lookup: always keyed by (task_id, file_id) together — never a global file_id lookup. */
  getTaskFile(taskId: string, fileId: string): HandoffTaskFile | null {
    const row = this.db
      .prepare(
        "SELECT * FROM handoff_task_files WHERE task_id = ? AND file_id = ?"
      )
      .get(taskId, fileId) as TaskFileRow | undefined;
    return row ? rowToTaskFile(row) : null;
  }

  /** Newest-first task rows for ops dashboard (full rows; callers must scrub). */
  listRecentTasks(limit = 40): HandoffTask[] {
    const n = Math.min(200, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT * FROM handoff_tasks
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(n) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Terminal-task counts by lease_owner since `sinceIso` (inclusive).
   * Honest aggregate for dashboard — not a max/capacity budget.
   */
  countTerminalByLeaseOwner(sinceIso: string): Map<
    string,
    { completed: number; failed: number; timedOut: number }
  > {
    const rows = this.db
      .prepare(
        `SELECT lease_owner AS owner, status, COUNT(*) AS n
         FROM handoff_tasks
         WHERE lease_owner IS NOT NULL
           AND status IN ('COMPLETED', 'FAILED', 'TIMED_OUT')
           AND COALESCE(completed_at, created_at) >= ?
         GROUP BY lease_owner, status`
      )
      .all(sinceIso) as unknown as Array<{
      owner: string;
      status: string;
      n: number;
    }>;
    const map = new Map<
      string,
      { completed: number; failed: number; timedOut: number }
    >();
    for (const row of rows) {
      const cur = map.get(row.owner) ?? {
        completed: 0,
        failed: 0,
        timedOut: 0,
      };
      if (row.status === "COMPLETED") cur.completed += Number(row.n);
      else if (row.status === "FAILED") cur.failed += Number(row.n);
      else if (row.status === "TIMED_OUT") cur.timedOut += Number(row.n);
      map.set(row.owner, cur);
    }
    return map;
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
      // Keep lease_owner for terminal attribution; token/expiry must drop.
      sets.push(clearLeaseAuthSets());
    }

    values.push(id);
    this.db
      .prepare(`UPDATE handoff_tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  /**
   * Worker/reaper timeout. Refuses to clobber COMPLETED (late-submit race).
   * Keeps lease_owner for dashboard attribution.
   */
  markTimedOutIfOpen(id: string, error: string): number {
    const info = this.db
      .prepare(
        `UPDATE handoff_tasks
         SET status = 'TIMED_OUT',
             error = ?,
             completed_at = ?,
             ${clearLeaseAuthSets()}
         WHERE id = ?
           AND status IN ('DISPATCHING', 'DISPATCHED', 'PROCESSING', 'WAITING_APPROVAL')
           AND result IS NULL`
      )
      .run(error, new Date().toISOString(), id);
    return Number(info.changes ?? 0);
  }

  /**
   * First completion only. Requires durable dispatch marker.
   * Clears lease auth but keeps lease_owner for ops counts.
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
             ${clearLeaseAuthSets()}
         WHERE id = ?
           AND status IN ('DISPATCHED', 'PROCESSING', 'WAITING_APPROVAL', 'TIMED_OUT')
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
           AND status IN ('QUEUED', 'DISPATCHING', 'DISPATCHED', 'PROCESSING', 'WAITING_APPROVAL', 'RATE_LIMITED')
           AND cursor_wait_notified_at IS NULL
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(conversationId) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  /**
   * Terminal task for this conversation that the Cursor stop hook has not
   * delivered a followup for yet (dedupes FAILED/QUEUED→terminal spam).
   */
  findUnresumedTerminalByConversation(
    conversationId: string
  ): HandoffTask | null {
    const row = this.db
      .prepare(
        `SELECT * FROM handoff_tasks
         WHERE cursor_conversation_id = ?
           AND status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
           AND cursor_followup_at IS NULL
         ORDER BY COALESCE(completed_at, created_at) ASC
         LIMIT 1`
      )
      .get(conversationId) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  /** CAS: claim one terminal followup delivery. Returns false if already claimed. */
  claimTerminalFollowup(taskId: string): boolean {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE handoff_tasks
         SET cursor_followup_at = ?
         WHERE id = ?
           AND cursor_followup_at IS NULL
           AND status IN (
             'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'READY_BUT_CURSOR_IDLE'
           )`
      )
      .run(now, taskId);
    return Number(info.changes ?? 0) === 1;
  }

  /**
   * CAS: mark wait-timeout followup delivered while task is still non-terminal.
   * Excludes the row from findPending so the stop hook does not re-wait/spam.
   * Later terminal completion can still notify via findUnresumedTerminal.
   */
  claimWaitTimeoutNotify(taskId: string): boolean {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE handoff_tasks
         SET cursor_wait_notified_at = ?
         WHERE id = ?
           AND cursor_wait_notified_at IS NULL
           AND status IN (
             'QUEUED', 'DISPATCHING', 'DISPATCHED',
             'PROCESSING', 'WAITING_APPROVAL', 'RATE_LIMITED'
           )`
      )
      .run(now, taskId);
    return Number(info.changes ?? 0) === 1;
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

      if (worker.error === "DISABLED") {
        this.db.exec("COMMIT");
        return null;
      }

      const probeRow = this.db
        .prepare(
          `SELECT * FROM handoff_tasks
           WHERE status = 'QUEUED'
             AND task_class = 'SYSTEM_PROBE'
             AND target_worker_id = ?
           ORDER BY created_at ASC
           LIMIT 1`
        )
        .get(workerId) as TaskRow | undefined;

      if (probeRow) {
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
          .run(workerId, leaseToken, expiresIso, probeRow.id);

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
          .run(probeRow.id, nowIso, workerId, instanceToken);

        this.db.exec("COMMIT");
        return {
          leaseToken,
          task: rowToTask({
            ...probeRow,
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
      }

      if (readinessBlocksClaim(worker.readiness_reason)) {
        this.db.exec("COMMIT");
        return null;
      }

      const maxTasks = parseMaxTasksPerChat(
        process.env.HANDOFF_MAX_TASKS_PER_CHAT
      );
      if (isChatBudgetExhausted(worker.tasks_on_chat ?? 0, maxTasks)) {
        this.db
          .prepare(
            `UPDATE worker_state
             SET readiness_reason = COALESCE(readiness_reason, 'THRESHOLD_REACHED')
             WHERE id = ? AND (readiness_reason IS NULL OR readiness_reason = '')`
          )
          .run(workerId);
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
             AND (task_class = 'USER' OR task_class IS NULL)
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
                   completed_at = ?,
                   ${clearLeaseAuthSets()}
               WHERE id = ? AND status = 'DISPATCHING' AND dispatch_started_at IS NULL`
            )
            .run(retryCount, nowIso, row.id);
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
                 ${clearLeaseAuthSets()}
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
                 ${clearLeaseAuthSets()}
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
           SET status = 'FAILED', retry_count = ?, error = ?, completed_at = ?, ${clearLeaseAuthSets()}
           WHERE id = ?`
        )
        .run(retryCount, error, new Date().toISOString(), taskId);
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

  /** Read worker row without auto-insert (fleet registry from DB). */
  findWorkerRegistryRow(workerId: string): WorkerStateRow | null {
    const row = this.db
      .prepare(`SELECT * FROM worker_state WHERE id = ?`)
      .get(workerId) as WorkerRow | undefined;
    return row ? rowToWorker(row) : null;
  }

  setWorkerChatUrl(workerId: string, workerUrl: string): void {
    const row = this.findWorkerRegistryRow(workerId);
    const prev = row?.workerUrl?.trim();
    const next = workerUrl.trim();
    if (prev && prev !== next) {
      this.db
        .prepare(
          `UPDATE worker_state
           SET worker_url = ?,
               mcp_write_verified_at = NULL,
               mcp_write_status = NULL,
               mcp_write_status_reason = NULL,
               readiness_reason = CASE
                 WHEN readiness_reason IN (
                   'RESTART_REQUIRED',
                   'ROTATION_FAILED',
                   'MCP_SAFETY_BLOCKED',
                   'MCP_TOOL_NOT_INVOKED',
                   'MCP_SUBMIT_TIMEOUT',
                   'PROBE_RESULT_MISMATCH'
                 ) THEN readiness_reason
                 ELSE 'MCP_APPROVAL_REQUIRED'
               END
           WHERE id = ?`
        )
        .run(next, workerId);
      return;
    }
    this.db
      .prepare(`UPDATE worker_state SET worker_url = ? WHERE id = ?`)
      .run(next, workerId);
  }

  /** Remove runtime row after registry entry deleted (v0.6 fleet ops). */
  deleteWorkerState(workerId: string): boolean {
    this.db
      .prepare(`DELETE FROM worker_operations WHERE worker_id = ?`)
      .run(workerId);
    const info = this.db
      .prepare(`DELETE FROM worker_state WHERE id = ?`)
      .run(workerId);
    return Number(info.changes ?? 0) > 0;
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
               instance_token, worker_url, cdp_endpoint, http_port, started_at, pid,
               tasks_on_chat, tasks_on_chat_url
             ) VALUES (?, 'STARTING', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 0, ?)`
          )
          .run(
            input.workerId,
            now,
            input.instanceToken,
            input.workerUrl,
            input.cdpEndpoint,
            input.httpPort ?? null,
            now,
            pid,
            input.workerUrl
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
        this.syncChatBudgetUrlOnRegister(
          input.workerId,
          input.workerUrl,
          existing,
          now
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

  /**
   * Record a successful TASK_ID send into the worker chat budget.
   * Idempotent per (worker_id, task_id) — retries do not double-count.
   */
  recordChatDispatch(input: {
    workerId: string;
    taskId: string;
    chatUrl: string;
  }): { recorded: boolean; tasksOnChat: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const ins = this.db
        .prepare(
          `INSERT OR IGNORE INTO worker_chat_dispatch
             (worker_id, task_id, chat_url, dispatched_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(input.workerId, input.taskId, input.chatUrl, now);

      const worker = this.db
        .prepare(
          `SELECT tasks_on_chat, tasks_on_chat_url FROM worker_state WHERE id = ?`
        )
        .get(input.workerId) as
        | { tasks_on_chat: number | null; tasks_on_chat_url: string | null }
        | undefined;

      if (!worker) {
        this.db.exec("ROLLBACK");
        throw new Error(`Worker not registered: ${input.workerId}`);
      }

      if (Number(ins.changes ?? 0) === 0) {
        this.db.exec("COMMIT");
        return {
          recorded: false,
          tasksOnChat: worker.tasks_on_chat ?? 0,
        };
      }

      let tasksOnChat: number;
      if (
        !worker.tasks_on_chat_url ||
        worker.tasks_on_chat_url !== input.chatUrl
      ) {
        tasksOnChat = 1;
        this.db
          .prepare(
            `UPDATE worker_state
             SET tasks_on_chat = ?, tasks_on_chat_url = ?
             WHERE id = ?`
          )
          .run(tasksOnChat, input.chatUrl, input.workerId);
      } else {
        tasksOnChat = (worker.tasks_on_chat ?? 0) + 1;
        this.db
          .prepare(`UPDATE worker_state SET tasks_on_chat = ? WHERE id = ?`)
          .run(tasksOnChat, input.workerId);
      }

      const maxTasks = parseMaxTasksPerChat(
        process.env.HANDOFF_MAX_TASKS_PER_CHAT
      );
      if (isChatBudgetExhausted(tasksOnChat, maxTasks)) {
        this.db
          .prepare(
            `UPDATE worker_state
             SET readiness_reason = COALESCE(readiness_reason, 'THRESHOLD_REACHED')
             WHERE id = ? AND (readiness_reason IS NULL OR readiness_reason = '')`
          )
          .run(input.workerId);
      }

      this.db.exec("COMMIT");
      return { recorded: true, tasksOnChat };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** When topology URL changes, reset counter for the new chat identity. */
  private syncChatBudgetUrlOnRegister(
    workerId: string,
    workerUrl: string,
    existing: WorkerRow,
    now: string
  ): void {
    const boundUrl = existing.tasks_on_chat_url ?? existing.worker_url;
    if (boundUrl && boundUrl !== workerUrl) {
      this.db
        .prepare(
          `UPDATE worker_state
           SET tasks_on_chat = 0,
               tasks_on_chat_url = ?,
               previous_worker_url = ?,
               chat_rotated_at = ?,
               readiness_reason = CASE
                 WHEN readiness_reason IN (
                   'RESTART_REQUIRED',
                   'CONSENT_REQUIRED',
                   'ROTATION_FAILED',
                   'MCP_SAFETY_BLOCKED',
                   'MCP_APPROVAL_REQUIRED',
                   'MCP_TOOL_NOT_INVOKED',
                   'MCP_SUBMIT_TIMEOUT',
                   'PROBE_RESULT_MISMATCH'
                 )
                   THEN readiness_reason
                 ELSE 'CONSENT_REQUIRED'
               END
           WHERE id = ?`
        )
        .run(workerUrl, boundUrl, now, workerId);
      return;
    }
    if (!existing.tasks_on_chat_url) {
      this.db
        .prepare(`UPDATE worker_state SET tasks_on_chat_url = ? WHERE id = ?`)
        .run(workerUrl, workerId);
    }
    if (existing.readiness_reason === "RESTART_REQUIRED") {
      this.db
        .prepare(
          `UPDATE worker_state SET readiness_reason = NULL, error = NULL WHERE id = ?`
        )
        .run(workerId);
    }
  }

  /** True if this worker currently owns a leased/in-flight task. */
  workerHasInFlight(workerId: string): boolean {
    return this.getInFlightTaskId(workerId) !== null;
  }

  /** First in-flight handoff task id blocking worker ops (lease or current_task_id). */
  getInFlightTaskId(workerId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM handoff_tasks
         WHERE lease_owner = ?
           AND status IN ('DISPATCHING','DISPATCHED','PROCESSING','WAITING_APPROVAL')
         LIMIT 1`
      )
      .get(workerId) as { id: string } | undefined;
    if (row) return row.id;
    const state = this.db
      .prepare(`SELECT current_task_id FROM worker_state WHERE id = ?`)
      .get(workerId) as { current_task_id: string | null } | undefined;
    return state?.current_task_id ?? null;
  }

  /**
   * Fail all in-flight tasks holding this worker busy (ops recovery).
   * Returns task ids transitioned to FAILED.
   */
  failInFlightTasksForWorker(
    workerId: string,
    reason = "released from ops dashboard"
  ): string[] {
    const msg = reason.trim().slice(0, 500) || "released from ops dashboard";
    const now = new Date().toISOString();
    const ids = new Set<string>();
    const leased = this.db
      .prepare(
        `SELECT id FROM handoff_tasks
         WHERE lease_owner = ?
           AND status IN ('DISPATCHING','DISPATCHED','PROCESSING','WAITING_APPROVAL')`
      )
      .all(workerId) as { id: string }[];
    for (const r of leased) ids.add(r.id);
    const state = this.db
      .prepare(`SELECT current_task_id FROM worker_state WHERE id = ?`)
      .get(workerId) as { current_task_id: string | null } | undefined;
    if (state?.current_task_id) ids.add(state.current_task_id);

    const failed: string[] = [];
    for (const taskId of ids) {
      const row = this.db
        .prepare(`SELECT status FROM handoff_tasks WHERE id = ?`)
        .get(taskId) as { status: string } | undefined;
      if (!row) continue;
      if (
        row.status === "COMPLETED" ||
        row.status === "FAILED" ||
        row.status === "CANCELLED" ||
        row.status === "TIMED_OUT"
      ) {
        continue;
      }
      const info = this.db
        .prepare(
          `UPDATE handoff_tasks
           SET status = 'FAILED',
               error = ?,
               completed_at = COALESCE(completed_at, ?),
               lease_token = NULL,
               lease_expires_at = NULL,
               lease_owner = NULL
           WHERE id = ? AND status = ?`
        )
        .run(msg, now, taskId, row.status);
      if (Number(info.changes ?? 0) === 1) {
        failed.push(taskId);
      }
    }
    this.db
      .prepare(
        `UPDATE worker_state
         SET current_task_id = NULL, last_seen_at = ?
         WHERE id = ?`
      )
      .run(now, workerId);
    return failed;
  }

  assertWorkerIdle(workerId: string): void {
    if (this.workerHasInFlight(workerId)) {
      throw new Error(
        `Worker ${workerId} is busy — refuse rotation while a task is in flight`
      );
    }
  }

  /**
   * Same SQLite IMMEDIATE lock as claimNextQueued: idle + not already reserved
   * → ROTATION_PENDING so the broker cannot claim during slow chat create.
   */
  beginRotationReservation(workerId: string): {
    previousReason: WorkerReadinessReason | null;
  } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const worker = this.db
        .prepare(`SELECT * FROM worker_state WHERE id = ?`)
        .get(workerId) as WorkerRow | undefined;
      if (!worker) {
        this.db.exec("ROLLBACK");
        throw new Error(`Worker ${workerId} not found`);
      }
      const inFlight = this.db
        .prepare(
          `SELECT id FROM handoff_tasks
           WHERE lease_owner = ?
             AND status IN ('DISPATCHING','DISPATCHED','PROCESSING','WAITING_APPROVAL')
           LIMIT 1`
        )
        .get(workerId) as { id: string } | undefined;
      if (inFlight || worker.current_task_id) {
        this.db.exec("ROLLBACK");
        throw new Error(
          `Worker ${workerId} is busy — refuse rotation while a task is in flight`
        );
      }
      const prev = (worker.readiness_reason ?? null) as
        | WorkerReadinessReason
        | null;
      if (
        prev === "ROTATION_PENDING" ||
        prev === "CONSENT_REQUIRED" ||
        prev === "RESTART_REQUIRED" ||
        prev === "ROTATION_FAILED"
      ) {
        this.db.exec("ROLLBACK");
        throw new Error(
          `Worker ${workerId} already blocked (${prev}) — refuse concurrent rotation`
        );
      }
      this.db
        .prepare(
          `UPDATE worker_state
           SET readiness_reason = 'ROTATION_PENDING',
               error = ?
           WHERE id = ?`
        )
        .run(
          prev
            ? `ROTATION_PENDING:prev=${prev}`
            : "ROTATION_PENDING: rotate-worker reserved",
          workerId
        );
      this.db.exec("COMMIT");
      return { previousReason: prev };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  beginWorkerUrlMutation(workerId: string): {
    previousReason: WorkerReadinessReason | null;
  } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const worker = this.db
        .prepare(`SELECT * FROM worker_state WHERE id = ?`)
        .get(workerId) as WorkerRow | undefined;
      if (!worker) {
        this.db.exec("ROLLBACK");
        throw new Error(`Worker ${workerId} not found`);
      }
      const inFlight = this.db
        .prepare(
          `SELECT id FROM handoff_tasks
           WHERE lease_owner = ?
             AND status IN ('DISPATCHING','DISPATCHED','PROCESSING','WAITING_APPROVAL')
           LIMIT 1`
        )
        .get(workerId) as { id: string } | undefined;
      if (inFlight || worker.current_task_id) {
        this.db.exec("ROLLBACK");
        throw new Error(
          `Worker ${workerId} is busy — refuse mutation while a task is in flight`
        );
      }
      const prev = (worker.readiness_reason ?? null) as
        | WorkerReadinessReason
        | null;
      if (
        prev === "ROTATION_PENDING" ||
        prev === "ROTATION_FAILED"
      ) {
        this.db.exec("ROLLBACK");
        throw new Error(
          `Worker ${workerId} already blocked (${prev}) — refuse concurrent mutation`
        );
      }
      this.db
        .prepare(
          `UPDATE worker_state
           SET readiness_reason = 'ROTATION_PENDING',
               error = ?
           WHERE id = ?`
        )
        .run(
          prev
            ? `ROTATION_PENDING:prev=${prev}`
            : "ROTATION_PENDING: worker-ops mutation",
          workerId
        );
      this.db.exec("COMMIT");
      return { previousReason: prev };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  clearWorkerError(workerId: string): void {
    this.db
      .prepare(
        `UPDATE worker_state SET readiness_reason = NULL, error = NULL WHERE id = ?`
      )
      .run(workerId);
  }

  /** Clear restart-recovery blockers after broker re-bind (not real runtime faults). */
  clearWorkerRecoveryBlockers(workerId: string): void {
    this.db
      .prepare(
        `UPDATE worker_state
         SET readiness_reason = NULL, error = NULL
         WHERE id = ?
           AND (
             readiness_reason IN (
               'CONSENT_REQUIRED',
               'ROTATION_FAILED',
               'RESTART_REQUIRED',
               'ROTATION_PENDING'
             )
             OR error LIKE 'PENDING_SETUP%'
             OR error LIKE 'worker-op failed%'
           )`
      )
      .run(workerId);
  }

  /** Drop stale CONSENT_REQUIRED once MCP read+write are already verified. */
  sweepStaleConsentRequired(workerId?: string): void {
    const sql = workerId
      ? `UPDATE worker_state
         SET readiness_reason = NULL, error = NULL
         WHERE id = ?
           AND readiness_reason = 'CONSENT_REQUIRED'
           AND mcp_read_verified_at IS NOT NULL
           AND mcp_write_verified_at IS NOT NULL`
      : `UPDATE worker_state
         SET readiness_reason = NULL, error = NULL
         WHERE readiness_reason = 'CONSENT_REQUIRED'
           AND mcp_read_verified_at IS NOT NULL
           AND mcp_write_verified_at IS NOT NULL`;
    this.db.prepare(sql).run(...(workerId ? [workerId] : []));
  }

  recordMcpReadVerified(workerId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE worker_state
         SET mcp_read_verified_at = ?
         WHERE id = ?`
      )
      .run(now, workerId);
  }

  recordMcpWriteVerified(workerId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE worker_state
         SET mcp_write_verified_at = ?,
             mcp_write_status = 'VERIFIED',
             mcp_write_status_reason = NULL,
             readiness_reason = CASE
               WHEN readiness_reason IN ('MCP_APPROVAL_REQUIRED', 'CONSENT_REQUIRED')
                 THEN NULL
               ELSE readiness_reason
             END,
             error = CASE
               WHEN readiness_reason IN ('MCP_APPROVAL_REQUIRED', 'CONSENT_REQUIRED')
                 THEN NULL
               ELSE error
             END
         WHERE id = ?`
      )
      .run(now, workerId);
  }

  recordMcpWriteDegraded(workerId: string, reason: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE worker_state
         SET mcp_write_status = 'DEGRADED',
             mcp_write_status_reason = ?,
             mcp_write_verified_at = NULL
         WHERE id = ?`
      )
      .run(`${reason} @ ${now}`.slice(0, 500), workerId);
  }

  clearMcpWriteDegraded(workerId: string): void {
    this.db
      .prepare(
        `UPDATE worker_state
         SET mcp_write_status = NULL,
             mcp_write_status_reason = NULL
         WHERE id = ? AND mcp_write_status = 'DEGRADED'`
      )
      .run(workerId);
  }

  setWorkerDisabled(workerId: string, disabled: boolean): void {
    if (disabled) {
      this.db
        .prepare(
          `UPDATE worker_state SET error = 'DISABLED', readiness_reason = NULL WHERE id = ?`
        )
        .run(workerId);
    } else {
      this.db
        .prepare(
          `UPDATE worker_state SET error = NULL WHERE id = ? AND error = 'DISABLED'`
        )
        .run(workerId);
    }
  }

  abortRotationReservation(
    workerId: string,
    previousReason: WorkerReadinessReason | null
  ): void {
    this.db
      .prepare(
        `UPDATE worker_state
         SET readiness_reason = ?, error = NULL
         WHERE id = ? AND readiness_reason = 'ROTATION_PENDING'`
      )
      .run(previousReason, workerId);
  }

  setReadinessReason(
    workerId: string,
    reason: WorkerReadinessReason | null,
    error?: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE worker_state
         SET readiness_reason = ?, error = COALESCE(?, error)
         WHERE id = ?`
      )
      .run(reason, error ?? null, workerId);
  }

  /**
   * Update worker URL during an active worker-op (keeps ROTATION_PENDING).
   */
  commitWorkerUrlDuringOp(input: {
    workerId: string;
    newWorkerUrl: string;
    previousWorkerUrl: string;
  }): void {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE worker_state
         SET worker_url = ?,
             tasks_on_chat = 0,
             tasks_on_chat_url = ?,
             previous_worker_url = ?,
             chat_rotated_at = ?,
             current_task_id = NULL,
             mcp_write_verified_at = NULL,
             mcp_write_status = NULL,
             mcp_write_status_reason = NULL,
             readiness_reason = CASE
               WHEN readiness_reason IN (
                 'RESTART_REQUIRED',
                 'ROTATION_FAILED',
                 'MCP_SAFETY_BLOCKED',
                 'MCP_TOOL_NOT_INVOKED',
                 'MCP_SUBMIT_TIMEOUT',
                 'PROBE_RESULT_MISMATCH'
               ) THEN readiness_reason
               ELSE 'MCP_APPROVAL_REQUIRED'
             END
         WHERE id = ?
           AND readiness_reason = 'ROTATION_PENDING'`
      )
      .run(
        input.newWorkerUrl,
        input.newWorkerUrl,
        input.previousWorkerUrl,
        now,
        input.workerId
      );
    if (Number(info.changes ?? 0) !== 1) {
      throw new Error(
        `commitWorkerUrlDuringOp: worker ${input.workerId} is not ROTATION_PENDING`
      );
    }
  }

  /**
   * Durable rotation commit: bind counter to new URL, reset count, set readiness.
   * Call only after topology file write succeeded (or in tests without a file).
   */
  commitChatRotation(input: {
    workerId: string;
    newWorkerUrl: string;
    previousWorkerUrl: string;
    readinessReason: WorkerReadinessReason;
    error?: string | null;
  }): void {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE worker_state
         SET worker_url = ?,
             tasks_on_chat = 0,
             tasks_on_chat_url = ?,
             previous_worker_url = ?,
             chat_rotated_at = ?,
             readiness_reason = ?,
             error = ?,
             current_task_id = NULL
         WHERE id = ?
           AND readiness_reason = 'ROTATION_PENDING'`
      )
      .run(
        input.newWorkerUrl,
        input.newWorkerUrl,
        input.previousWorkerUrl,
        now,
        input.readinessReason,
        input.error ?? `${input.readinessReason}: rotate-worker`,
        input.workerId
      );
    if (Number(info.changes ?? 0) !== 1) {
      throw new Error(
        `commitChatRotation: worker ${input.workerId} is not ROTATION_PENDING`
      );
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
      if (workerId !== DEFAULT_WORKER_ID) {
        throw new Error(`Worker ${workerId} not found`);
      }
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
      readinessReason?: WorkerReadinessReason | null;
    }> = {}
  ): void {
    const existing = this.db
      .prepare("SELECT id, instance_token FROM worker_state WHERE id = ?")
      .get(workerId) as { id: string; instance_token: string | null } | undefined;

    const now = new Date().toISOString();

    if (!existing) {
      if (workerId !== DEFAULT_WORKER_ID) {
        return;
      }
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
    if ("readinessReason" in extra) {
      sets.push("readiness_reason = ?");
      values.push(extra.readinessReason ?? null);
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
