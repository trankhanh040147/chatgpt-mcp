import type { DatabaseSync } from "node:sqlite";
import type {
  HandoffTask,
  HandoffTaskContext,
  HandoffResultMetadata,
  HandoffTaskStatus,
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
}

interface WorkerRow {
  id: string;
  status: string;
  last_seen_at: string | null;
  current_task_id: string | null;
  error: string | null;
}

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
  };
}

export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertTask(task: HandoffTask): void {
    this.db
      .prepare(
        `INSERT INTO handoff_tasks (
          id, cursor_conversation_id, type, prompt, context_json,
          status, retry_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.cursorConversationId,
        task.type,
        task.prompt,
        task.context ? JSON.stringify(task.context) : null,
        task.status,
        task.retryCount,
        task.createdAt
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

    values.push(id);
    this.db
      .prepare(`UPDATE handoff_tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  saveResult(
    id: string,
    result: string,
    metadata?: HandoffResultMetadata
  ): void {
    this.db
      .prepare(
        `UPDATE handoff_tasks
         SET status = ?, result = ?, result_metadata_json = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(
        "COMPLETED",
        result,
        metadata ? JSON.stringify(metadata) : null,
        new Date().toISOString(),
        id
      );
  }

  findPendingByConversation(conversationId: string): HandoffTask | null {
    const row = this.db
      .prepare(
        `SELECT * FROM handoff_tasks
         WHERE cursor_conversation_id = ?
           AND status IN ('QUEUED', 'DISPATCHING', 'DISPATCHED', 'PROCESSING', 'WAITING_APPROVAL', 'RATE_LIMITED')
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

  claimOldestQueued(): HandoffTask | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
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

      const updated = this.db
        .prepare(
          `UPDATE handoff_tasks SET status = 'DISPATCHING' WHERE id = ? AND status = 'QUEUED'`
        )
        .run(row.id);

      if (updated.changes === 0) {
        this.db.exec("COMMIT");
        return null;
      }

      this.db.exec("COMMIT");
      return rowToTask({ ...row, status: "DISPATCHING" });
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getWorkerState(workerId = DEFAULT_WORKER_ID): {
    id: string;
    status: WorkerStatus;
    lastSeenAt?: string;
    currentTaskId?: string;
    error?: string;
  } {
    const row = this.db
      .prepare("SELECT * FROM worker_state WHERE id = ?")
      .get(workerId) as WorkerRow | undefined;

    if (!row) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO worker_state (id, status, last_seen_at) VALUES (?, 'STARTING', ?)`
        )
        .run(workerId, now);
      return { id: workerId, status: "STARTING", lastSeenAt: now };
    }

    return {
      id: row.id,
      status: row.status as WorkerStatus,
      lastSeenAt: row.last_seen_at ?? undefined,
      currentTaskId: row.current_task_id ?? undefined,
      error: row.error ?? undefined,
    };
  }

  updateWorkerState(
    workerId: string,
    status: WorkerStatus,
    extra: Partial<{ currentTaskId: string | null; error: string | null }> = {}
  ): void {
    const existing = this.db
      .prepare("SELECT id FROM worker_state WHERE id = ?")
      .get(workerId);

    const now = new Date().toISOString();

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO worker_state (id, status, last_seen_at, current_task_id, error)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          workerId,
          status,
          now,
          extra.currentTaskId ?? null,
          extra.error ?? null
        );
      return;
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
}
