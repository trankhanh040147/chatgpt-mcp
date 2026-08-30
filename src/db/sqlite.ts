import {
  DatabaseSync,
  type StatementSync,
} from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTaskUsageTable } from "../usage/task-usage.repository.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Multi-worker leases / fencing + task_usage + chat rotation + hook followup ack + worker ops. */
export const SCHEMA_USER_VERSION = 8;

let dbInstance: DatabaseSync | null = null;

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`
    )
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string
): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/** Minimal pre-0.2.0 tables so ALTER can run on existing installs. */
function ensureLegacyBaseTables(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS handoff_tasks (
    id TEXT PRIMARY KEY,
    cursor_conversation_id TEXT NOT NULL,
    type TEXT NOT NULL,
    prompt TEXT NOT NULL,
    context_json TEXT,
    status TEXT NOT NULL,
    result TEXT,
    result_metadata_json TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    dispatched_at TEXT,
    processing_at TEXT,
    completed_at TEXT,
    error TEXT
);
CREATE TABLE IF NOT EXISTS worker_state (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_seen_at TEXT,
    current_task_id TEXT,
    error TEXT
);
`);
}

/**
 * Offline-safe migration to SCHEMA_USER_VERSION.
 * Ambiguous in-flight rows → TIMED_OUT (pre-0.2.0 sent before DISPATCHED).
 */
export function migrateDatabase(db: DatabaseSync): void {
  const versionRow = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  let version = Number(versionRow?.user_version ?? 0);

  // Always ensure new columns exist even when version already bumped
  // (e.g. v2→v3 pid) without re-failing closed tasks.
  ensureLegacyBaseTables(db);
  if (tableExists(db, "handoff_tasks")) {
    addColumnIfMissing(db, "handoff_tasks", "workspace_root", "workspace_root TEXT");
    addColumnIfMissing(
      db,
      "handoff_tasks",
      "cursor_followup_at",
      "cursor_followup_at TEXT"
    );
    addColumnIfMissing(
      db,
      "handoff_tasks",
      "cursor_wait_notified_at",
      "cursor_wait_notified_at TEXT"
    );
    addColumnIfMissing(
      db,
      "handoff_tasks",
      "task_class",
      "task_class TEXT NOT NULL DEFAULT 'USER'"
    );
    addColumnIfMissing(
      db,
      "handoff_tasks",
      "target_worker_id",
      "target_worker_id TEXT"
    );
  }
  if (!tableExists(db, "worker_operations")) {
    db.exec(`
CREATE TABLE IF NOT EXISTS worker_operations (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_operations_active
ON worker_operations(worker_id, state);
`);
  }
  if (tableExists(db, "worker_state")) {
    addColumnIfMissing(db, "worker_state", "pid", "pid INTEGER");
    addColumnIfMissing(
      db,
      "worker_state",
      "tasks_on_chat",
      "tasks_on_chat INTEGER NOT NULL DEFAULT 0"
    );
    addColumnIfMissing(
      db,
      "worker_state",
      "tasks_on_chat_url",
      "tasks_on_chat_url TEXT"
    );
    addColumnIfMissing(
      db,
      "worker_state",
      "previous_worker_url",
      "previous_worker_url TEXT"
    );
    addColumnIfMissing(
      db,
      "worker_state",
      "chat_rotated_at",
      "chat_rotated_at TEXT"
    );
    addColumnIfMissing(
      db,
      "worker_state",
      "readiness_reason",
      "readiness_reason TEXT"
    );
  }

  if (version >= SCHEMA_USER_VERSION) {
    const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
    db.exec(schema);
    ensureTaskUsageTable(db);
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    ensureLegacyBaseTables(db);

    if (tableExists(db, "handoff_tasks")) {
      addColumnIfMissing(db, "handoff_tasks", "lease_owner", "lease_owner TEXT");
      addColumnIfMissing(db, "handoff_tasks", "lease_token", "lease_token TEXT");
      addColumnIfMissing(
        db,
        "handoff_tasks",
        "lease_expires_at",
        "lease_expires_at TEXT"
      );
      addColumnIfMissing(
        db,
        "handoff_tasks",
        "dispatch_started_at",
        "dispatch_started_at TEXT"
      );
      addColumnIfMissing(
        db,
        "handoff_tasks",
        "dispatch_attempt",
        "dispatch_attempt INTEGER NOT NULL DEFAULT 0"
      );
      addColumnIfMissing(
        db,
        "handoff_tasks",
        "nudge_started_at",
        "nudge_started_at TEXT"
      );
      addColumnIfMissing(
        db,
        "handoff_tasks",
        "nudge_attempt",
        "nudge_attempt INTEGER NOT NULL DEFAULT 0"
      );
    }

    if (tableExists(db, "worker_state")) {
      addColumnIfMissing(
        db,
        "worker_state",
        "instance_token",
        "instance_token TEXT"
      );
      addColumnIfMissing(db, "worker_state", "worker_url", "worker_url TEXT");
      addColumnIfMissing(
        db,
        "worker_state",
        "cdp_endpoint",
        "cdp_endpoint TEXT"
      );
      addColumnIfMissing(db, "worker_state", "http_port", "http_port INTEGER");
      addColumnIfMissing(db, "worker_state", "started_at", "started_at TEXT");
      addColumnIfMissing(db, "worker_state", "pid", "pid INTEGER");
    }

    // Indexes / full CREATE IF NOT EXISTS after columns exist.
    // Note: CREATE TABLE IF NOT EXISTS will not reshape an old table — ALTERs above did.
    const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
    db.exec(schema);
    ensureTaskUsageTable(db);

    if (tableExists(db, "handoff_tasks") && version < 2) {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE handoff_tasks
         SET status = 'TIMED_OUT',
             error = COALESCE(error, 'Migrated: ambiguous in-flight task (schema v2)'),
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             completed_at = COALESCE(completed_at, ?)
         WHERE status IN (
           'DISPATCHING', 'DISPATCHED', 'PROCESSING', 'WAITING_APPROVAL', 'RATE_LIMITED'
         )`
      ).run(now);
    }

    // v7: stop-hook followup ack — backfill so old terminal rows are not re-notified.
    if (tableExists(db, "handoff_tasks") && version < 7) {
      db.prepare(
        `UPDATE handoff_tasks
         SET cursor_followup_at = COALESCE(completed_at, created_at)
         WHERE cursor_followup_at IS NULL
           AND status IN (
             'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'READY_BUT_CURSOR_IDLE'
           )`
      ).run();
    }

    db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function initDatabase(dbPath: string): DatabaseSync {
  if (dbInstance) return dbInstance;

  mkdirSync(dirname(dbPath), { recursive: true });

  if (existsSync(dbPath)) {
    const backup = `${dbPath}.bak-pre-v${SCHEMA_USER_VERSION}`;
    if (!existsSync(backup)) {
      try {
        copyFileSync(dbPath, backup);
      } catch {
        // Best-effort backup; migration still proceeds.
      }
    }
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  // Never apply lease indexes before migrate adds columns on legacy DBs.
  migrateDatabase(db);

  dbInstance = db;
  return db;
}

export function getDatabase(): DatabaseSync {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/** Test helper: reset singleton between unit tests. */
export function resetDatabaseForTests(): void {
  closeDatabase();
}

export type { StatementSync };
