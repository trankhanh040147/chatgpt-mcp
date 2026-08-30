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

const ACTIVE_STATES: WorkerOperationState[] = [
  "PENDING",
  "RUNNING",
  "VERIFYING",
];

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
    const lastError = patch.lastError !== undefined ? patch.lastError : existing.lastError;
    this.db
      .prepare(
        `UPDATE worker_operations
         SET state = ?, payload_json = ?, attempt = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        state,
        JSON.stringify(payload),
        attempt,
        lastError,
        now,
        id
      );
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
