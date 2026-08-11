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

CREATE INDEX IF NOT EXISTS idx_handoff_status
ON handoff_tasks(status);

CREATE INDEX IF NOT EXISTS idx_cursor_conversation
ON handoff_tasks(cursor_conversation_id);

CREATE TABLE IF NOT EXISTS worker_state (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_seen_at TEXT,
    current_task_id TEXT,
    error TEXT
);
