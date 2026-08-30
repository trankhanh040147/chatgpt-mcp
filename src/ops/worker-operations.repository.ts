import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import type {
  WorkerOperation,
  WorkerOperationKind,
  WorkerOperationPayload,
  WorkerOperationState,
} from "./worker-operation.types.js";

interface Row {
  id: string;
  worker_id: string;
  kind: string;
  state: string;
  payload_json: string;
  attempt: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkerStateRow {
  id: string;
  current_task_id: string | null;
  readiness_reason: string | null;
}

function rowToOp(row: Row): WorkerOperation {
  return {
    id: row.id,
    workerId: row.worker_id,
    kind: row.kind as WorkerOperationKind,
    state: row.state as WorkerOperationState,
    payload: JSON.parse(row.payload_json) as WorkerOperationPayload,
    attempt: row.attempt,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkerOperationsRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Atomically reserve worker (ROTATION_PENDING) and insert durable operation.
   * Crash before COMMIT leaves neither reservation nor operation.
   */
  enqueueWithReservation(input: {
    workerId: string;
    kind: WorkerOperationKind;
    payload: WorkerOperationPayload;
  }): WorkerOperation {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const worker = this.db
        .prepare(`SELECT * FROM worker_state WHERE id = ?`)
        .get(input.workerId) as WorkerStateRow | undefined;
      if (!worker) {
        this.db.exec("ROLLBACK");
        throw new Error(`Worker ${input.workerId} not found`);
      }

      const inFlight = this.db
        .prepare(
          `SELECT id FROM handoff_tasks
           WHERE lease_owner = ?
             AND status IN ('DISPATCHING','DISPATCHED','PROCESSING','WAITING_APPROVAL')
           LIMIT 1`
        )
        .get(input.workerId) as { id: string } | undefined;
      if (inFlight || worker.current_task_id) {
        this.db.exec("ROLLBACK");
        throw new Error(
          `Worker ${input.workerId} is busy — refuse mutation while a task is in flight`
        );
      }

      const activeOp = this.db
        .prepare(
          `SELECT id FROM worker_operations
           WHERE worker_id = ?
             AND state IN ('PENDING', 'RUNNING', 'VERIFYING')
           LIMIT 1`
        )
        .get(input.workerId) as { id: string } | undefined;
      if (activeOp) {
        this.db.exec("ROLLBACK");
        throw new Error(
          `Worker ${input.workerId} already has an active operation — wait or retry later`
        );
      }

      const prev = worker.readiness_reason ?? null;

      const payload: WorkerOperationPayload = {
        ...input.payload,
        reservationPreviousReason: prev,
      };

      if (prev === "ROTATION_PENDING") {
        this.db.exec("ROLLBACK");
        throw new Error(
          `Worker ${input.workerId} already blocked (${prev}) — wait for current rotation or cancel stuck op`
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
          input.workerId
        );

      const now = new Date().toISOString();
      const id = `wop_${ulid()}`;
      this.db
        .prepare(
          `INSERT INTO worker_operations (
            id, worker_id, kind, state, payload_json, attempt, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, 'PENDING', ?, 0, NULL, ?, ?)`
        )
        .run(
          id,
          input.workerId,
          input.kind,
          JSON.stringify(payload),
          now,
          now
        );

      this.db.exec("COMMIT");
      return this.getById(id)!;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  create(input: {
    workerId: string;
    kind: WorkerOperationKind;
    payload: WorkerOperationPayload;
  }): WorkerOperation {
    const now = new Date().toISOString();
    const id = `wop_${ulid()}`;
    this.db
      .prepare(
        `INSERT INTO worker_operations (
          id, worker_id, kind, state, payload_json, attempt, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, 'PENDING', ?, 0, NULL, ?, ?)`
      )
      .run(
        id,
        input.workerId,
        input.kind,
        JSON.stringify(input.payload),
        now,
        now
      );
    return this.getById(id)!;
  }

  getById(id: string): WorkerOperation | null {
    const row = this.db
      .prepare("SELECT * FROM worker_operations WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? rowToOp(row) : null;
  }

  listActive(): WorkerOperation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM worker_operations
         WHERE state IN ('PENDING', 'RUNNING', 'VERIFYING')
         ORDER BY created_at ASC`
      )
      .all() as unknown as Row[];
    return rows.map(rowToOp);
  }

  listActiveForWorker(workerId: string): WorkerOperation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM worker_operations
         WHERE worker_id = ?
           AND state IN ('PENDING', 'RUNNING', 'VERIFYING')
         ORDER BY created_at ASC`
      )
      .all(workerId) as unknown as Row[];
    return rows.map(rowToOp);
  }

  update(
    id: string,
    patch: {
      state?: WorkerOperationState;
      payload?: WorkerOperationPayload;
      attempt?: number;
      lastError?: string | null;
    }
  ): WorkerOperation {
    const existing = this.getById(id);
    if (!existing) throw new Error(`worker operation not found: ${id}`);
    const now = new Date().toISOString();
    const payload = patch.payload ?? existing.payload;
    const state = patch.state ?? existing.state;
    const attempt = patch.attempt ?? existing.attempt;
    const lastError =
      patch.lastError !== undefined ? patch.lastError : existing.lastError;
    this.db
      .prepare(
        `UPDATE worker_operations
         SET state = ?, payload_json = ?, attempt = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(state, JSON.stringify(payload), attempt, lastError, now, id);
    return this.getById(id)!;
  }

  hasActiveForWorker(workerId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM worker_operations
         WHERE worker_id = ? AND state IN ('PENDING', 'RUNNING', 'VERIFYING')
         LIMIT 1`
      )
      .get(workerId) as { ok: number } | undefined;
    return Boolean(row);
  }
}
