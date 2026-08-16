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
    error TEXT,
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    dispatch_started_at TEXT,
    dispatch_attempt INTEGER NOT NULL DEFAULT 0,
    nudge_started_at TEXT,
    nudge_attempt INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_handoff_status
ON handoff_tasks(status);

CREATE INDEX IF NOT EXISTS idx_cursor_conversation
ON handoff_tasks(cursor_conversation_id);

CREATE INDEX IF NOT EXISTS idx_handoff_lease_expires
ON handoff_tasks(lease_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_task_per_worker
ON handoff_tasks(lease_owner)
WHERE lease_owner IS NOT NULL
  AND status IN (
    'DISPATCHING',
    'DISPATCHED',
    'PROCESSING',
    'WAITING_APPROVAL'
  );

CREATE TABLE IF NOT EXISTS worker_state (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_seen_at TEXT,
    current_task_id TEXT,
    error TEXT,
    instance_token TEXT,
    worker_url TEXT,
    cdp_endpoint TEXT,
    http_port INTEGER,
    started_at TEXT,
    pid INTEGER
);
