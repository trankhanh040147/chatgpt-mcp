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
    pid INTEGER,
    tasks_on_chat INTEGER NOT NULL DEFAULT 0,
    tasks_on_chat_url TEXT,
    previous_worker_url TEXT,
    chat_rotated_at TEXT,
    readiness_reason TEXT
);

CREATE TABLE IF NOT EXISTS worker_chat_dispatch (
    worker_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    chat_url TEXT NOT NULL,
    dispatched_at TEXT NOT NULL,
    PRIMARY KEY (worker_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_worker_chat_dispatch_url
ON worker_chat_dispatch(worker_id, chat_url);

CREATE TABLE IF NOT EXISTS task_usage (
    task_id TEXT PRIMARY KEY REFERENCES handoff_tasks(id) ON DELETE CASCADE,
    input_tokens_est INTEGER NOT NULL CHECK (input_tokens_est >= 0),
    output_tokens_est INTEGER NOT NULL CHECK (output_tokens_est >= 0),
    total_tokens_est INTEGER NOT NULL,
    input_tokens_low INTEGER NOT NULL CHECK (input_tokens_low >= 0),
    input_tokens_high INTEGER NOT NULL,
    output_tokens_low INTEGER NOT NULL CHECK (output_tokens_low >= 0),
    output_tokens_high INTEGER NOT NULL,
    estimator_key TEXT NOT NULL,
    estimator_version TEXT NOT NULL,
    token_scope TEXT NOT NULL DEFAULT 'stored_prompt_result_text_only',
    confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
    counterfactual_model TEXT NOT NULL,
    price_table_version TEXT NOT NULL,
    input_price_microusd_per_mtok INTEGER NOT NULL CHECK (input_price_microusd_per_mtok >= 0),
    output_price_microusd_per_mtok INTEGER NOT NULL CHECK (output_price_microusd_per_mtok >= 0),
    overhead_price_microusd_per_mtok INTEGER NOT NULL DEFAULT 0,
    context_multiplier_milli INTEGER NOT NULL DEFAULT 1000,
    api_equiv_avoided_microusd INTEGER NOT NULL CHECK (api_equiv_avoided_microusd >= 0),
    api_equiv_avoided_low_microusd INTEGER NOT NULL CHECK (api_equiv_avoided_low_microusd >= 0),
    api_equiv_avoided_high_microusd INTEGER NOT NULL,
    subscription_allocated_microusd INTEGER,
    cash_saved_microusd INTEGER,
    computed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_usage_model_version
ON task_usage(counterfactual_model, price_table_version);
