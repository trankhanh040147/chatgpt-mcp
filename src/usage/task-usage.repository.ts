import type { DatabaseSync } from "node:sqlite";
import type { TaskUsageSnapshot, UsageAggBundle, UsageWindowAgg } from "./usage.types.js";
import { microToUsd } from "./pricing.js";

export function ensureTaskUsageTable(db: DatabaseSync): void {
  db.exec(`
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
`);
}

type UsageRow = {
  task_id: string;
  input_tokens_est: number;
  output_tokens_est: number;
  total_tokens_est: number;
  input_tokens_low: number;
  input_tokens_high: number;
  output_tokens_low: number;
  output_tokens_high: number;
  estimator_key: string;
  estimator_version: string;
  token_scope: string;
  confidence: "low" | "medium" | "high";
  counterfactual_model: string;
  price_table_version: string;
  input_price_microusd_per_mtok: number;
  output_price_microusd_per_mtok: number;
  overhead_price_microusd_per_mtok: number;
  context_multiplier_milli: number;
  api_equiv_avoided_microusd: number;
  api_equiv_avoided_low_microusd: number;
  api_equiv_avoided_high_microusd: number;
  subscription_allocated_microusd: number | null;
  cash_saved_microusd: number | null;
  computed_at: string;
};

function rowToSnapshot(row: UsageRow): TaskUsageSnapshot {
  return {
    inputTokensEst: row.input_tokens_est,
    outputTokensEst: row.output_tokens_est,
    totalTokensEst: row.total_tokens_est,
    inputTokensLow: row.input_tokens_low,
    inputTokensHigh: row.input_tokens_high,
    outputTokensLow: row.output_tokens_low,
    outputTokensHigh: row.output_tokens_high,
    estimatorKey: row.estimator_key,
    estimatorVersion: row.estimator_version,
    tokenScope: "stored_prompt_result_text_only",
    confidence: row.confidence,
    counterfactualModel: row.counterfactual_model,
    priceTableVersion: row.price_table_version,
    inputPriceMicroUsdPerMTok: row.input_price_microusd_per_mtok,
    outputPriceMicroUsdPerMTok: row.output_price_microusd_per_mtok,
    overheadPriceMicroUsdPerMTok: row.overhead_price_microusd_per_mtok,
    contextMultiplierMilli: row.context_multiplier_milli,
    apiEquivAvoidedMicroUsd: row.api_equiv_avoided_microusd,
    apiEquivAvoidedLowMicroUsd: row.api_equiv_avoided_low_microusd,
    apiEquivAvoidedHighMicroUsd: row.api_equiv_avoided_high_microusd,
    subscriptionAllocatedMicroUsd: null,
    cashSavedMicroUsd: null,
    computedAt: row.computed_at,
  };
}

export function insertTaskUsage(
  db: DatabaseSync,
  taskId: string,
  snap: TaskUsageSnapshot,
  replace = false
): void {
  const sql = replace
    ? `INSERT OR REPLACE INTO task_usage`
    : `INSERT OR IGNORE INTO task_usage`;
  db.prepare(
    `${sql} (
      task_id, input_tokens_est, output_tokens_est, total_tokens_est,
      input_tokens_low, input_tokens_high, output_tokens_low, output_tokens_high,
      estimator_key, estimator_version, token_scope, confidence,
      counterfactual_model, price_table_version,
      input_price_microusd_per_mtok, output_price_microusd_per_mtok,
      overhead_price_microusd_per_mtok, context_multiplier_milli,
      api_equiv_avoided_microusd, api_equiv_avoided_low_microusd,
      api_equiv_avoided_high_microusd, subscription_allocated_microusd,
      cash_saved_microusd, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
  ).run(
    taskId,
    snap.inputTokensEst,
    snap.outputTokensEst,
    snap.totalTokensEst,
    snap.inputTokensLow,
    snap.inputTokensHigh,
    snap.outputTokensLow,
    snap.outputTokensHigh,
    snap.estimatorKey,
    snap.estimatorVersion,
    snap.tokenScope,
    snap.confidence,
    snap.counterfactualModel,
    snap.priceTableVersion,
    snap.inputPriceMicroUsdPerMTok,
    snap.outputPriceMicroUsdPerMTok,
    snap.overheadPriceMicroUsdPerMTok,
    snap.contextMultiplierMilli,
    snap.apiEquivAvoidedMicroUsd,
    snap.apiEquivAvoidedLowMicroUsd,
    snap.apiEquivAvoidedHighMicroUsd,
    snap.computedAt
  );
}

export function getTaskUsage(
  db: DatabaseSync,
  taskId: string
): TaskUsageSnapshot | null {
  const row = db
    .prepare(`SELECT * FROM task_usage WHERE task_id = ?`)
    .get(taskId) as UsageRow | undefined;
  return row ? rowToSnapshot(row) : null;
}

export function getTaskUsageMap(
  db: DatabaseSync,
  taskIds: string[]
): Map<string, TaskUsageSnapshot> {
  const map = new Map<string, TaskUsageSnapshot>();
  if (taskIds.length === 0) return map;
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM task_usage WHERE task_id IN (${placeholders})`
    )
    .all(...taskIds) as UsageRow[];
  for (const row of rows) map.set(row.task_id, rowToSnapshot(row));
  return map;
}

function emptyWindow(): UsageWindowAgg {
  return {
    completedTasks: 0,
    measuredTasks: 0,
    estimatedTokens: 0,
    apiEquivalentAvoidedUsd: 0,
  };
}

function windowFromParts(
  completed: number,
  measured: number,
  tokens: number,
  micro: number
): UsageWindowAgg {
  return {
    completedTasks: completed,
    measuredTasks: measured,
    estimatedTokens: tokens,
    apiEquivalentAvoidedUsd: microToUsd(micro),
  };
}

export function aggregateUsageByWorker(
  db: DatabaseSync,
  sinceIso: string | null
): Map<string, UsageWindowAgg> {
  const whereSince = sinceIso
    ? `AND t.completed_at IS NOT NULL AND t.completed_at >= ?`
    : "";
  const params = sinceIso ? [sinceIso] : [];
  const rows = db
    .prepare(
      `SELECT
         COALESCE(t.lease_owner, '(unknown)') AS worker_id,
         COUNT(*) AS completed_tasks,
         COUNT(u.task_id) AS measured_tasks,
         COALESCE(SUM(u.total_tokens_est), 0) AS tokens,
         COALESCE(SUM(u.api_equiv_avoided_microusd), 0) AS micro
       FROM handoff_tasks t
       LEFT JOIN task_usage u ON u.task_id = t.id
       WHERE t.status = 'COMPLETED'
         ${whereSince}
       GROUP BY COALESCE(t.lease_owner, '(unknown)')`
    )
    .all(...params) as Array<{
    worker_id: string;
    completed_tasks: number;
    measured_tasks: number;
    tokens: number;
    micro: number;
  }>;
  const map = new Map<string, UsageWindowAgg>();
  for (const r of rows) {
    map.set(
      r.worker_id,
      windowFromParts(
        Number(r.completed_tasks),
        Number(r.measured_tasks),
        Number(r.tokens),
        Number(r.micro)
      )
    );
  }
  return map;
}

export function aggregateUsageTotal(
  db: DatabaseSync,
  sinceIso: string | null
): UsageWindowAgg {
  const whereSince = sinceIso
    ? `AND t.completed_at IS NOT NULL AND t.completed_at >= ?`
    : "";
  const params = sinceIso ? [sinceIso] : [];
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS completed_tasks,
         COUNT(u.task_id) AS measured_tasks,
         COALESCE(SUM(u.total_tokens_est), 0) AS tokens,
         COALESCE(SUM(u.api_equiv_avoided_microusd), 0) AS micro
       FROM handoff_tasks t
       LEFT JOIN task_usage u ON u.task_id = t.id
       WHERE t.status = 'COMPLETED'
         ${whereSince}`
    )
    .get(...params) as {
    completed_tasks: number;
    measured_tasks: number;
    tokens: number;
    micro: number;
  };
  return windowFromParts(
    Number(row.completed_tasks),
    Number(row.measured_tasks),
    Number(row.tokens),
    Number(row.micro)
  );
}

export function usageBundleForWorker(
  db: DatabaseSync,
  workerId: string,
  since24hIso: string
): UsageAggBundle {
  const last24 = aggregateUsageByWorker(db, since24hIso).get(workerId);
  const all = aggregateUsageByWorker(db, null).get(workerId);
  return {
    last24h: last24 ?? emptyWindow(),
    allTime: all ?? emptyWindow(),
  };
}

export function usageBundleTotal(
  db: DatabaseSync,
  since24hIso: string
): UsageAggBundle {
  return {
    last24h: aggregateUsageTotal(db, since24hIso),
    allTime: aggregateUsageTotal(db, null),
  };
}

/** Compact list/detail JSON helpers */
export function usageEstimateListJson(
  snap: TaskUsageSnapshot | null,
  opts?: { referencePricingEnabled?: boolean; scenarioDisplayName?: string }
) {
  if (!snap) return null;
  const showRef = Boolean(opts?.referencePricingEnabled);
  const usd = microToUsd(snap.apiEquivAvoidedMicroUsd);
  return {
    inputTokens: snap.inputTokensEst,
    outputTokens: snap.outputTokensEst,
    totalTokens: snap.totalTokensEst,
    confidence: snap.confidence,
    isEstimated: true,
    // Dollars only when reference pricing is enabled (not ChatGPT billing).
    referenceCostUsd: showRef ? usd : null,
    comparisonScenario: showRef
      ? opts?.scenarioDisplayName ?? snap.counterfactualModel
      : null,
    // Deprecated aliases — keep for one release; prefer referenceCostUsd.
    apiEquivalentAvoidedUsd: showRef ? usd : null,
    counterfactualModel: showRef ? snap.counterfactualModel : null,
  };
}

export function usageEstimateDetailJson(
  snap: TaskUsageSnapshot | null,
  opts?: { referencePricingEnabled?: boolean; scenarioDisplayName?: string }
) {
  if (!snap) return null;
  const enabled = Boolean(opts?.referencePricingEnabled);
  const usd = microToUsd(snap.apiEquivAvoidedMicroUsd);
  const low = microToUsd(snap.apiEquivAvoidedLowMicroUsd);
  const high = microToUsd(snap.apiEquivAvoidedHighMicroUsd);
  const scenario =
    opts?.scenarioDisplayName ??
    `Cursor alternative · ${snap.counterfactualModel}`;
  return {
    tokens: {
      input: snap.inputTokensEst,
      output: snap.outputTokensEst,
      total: snap.totalTokensEst,
      low: snap.inputTokensLow + snap.outputTokensLow,
      high: snap.inputTokensHigh + snap.outputTokensHigh,
    },
    cost: enabled
      ? {
          currency: "USD",
          metric: "reference_api_cost",
          referenceCostUsd: usd,
          lowUsd: low,
          highUsd: high,
          cashSavedUsd: null,
          apiEquivalentAvoidedUsd: usd,
        }
      : {
          currency: "USD",
          metric: "not_measured",
          referenceCostUsd: null,
          lowUsd: null,
          highUsd: null,
          cashSavedUsd: null,
          apiEquivalentAvoidedUsd: null,
          note: "Runs in ChatGPT web under your subscription; no per-handoff invoice is available.",
        },
    comparison: enabled
      ? {
          scenarioId: snap.counterfactualModel,
          scenarioLabel: scenario,
          inputUsdPerMTok: snap.inputPriceMicroUsdPerMTok / 1_000_000,
          outputUsdPerMTok: snap.outputPriceMicroUsdPerMTok / 1_000_000,
          overheadUsdPerMTok: snap.overheadPriceMicroUsdPerMTok / 1_000_000,
          contextMultiplier: snap.contextMultiplierMilli / 1000,
          priceTableVersion: snap.priceTableVersion,
          context: "counterfactual",
        }
      : null,
    counterfactual: enabled
      ? {
          model: snap.counterfactualModel,
          scenarioLabel: scenario,
          inputUsdPerMTok: snap.inputPriceMicroUsdPerMTok / 1_000_000,
          outputUsdPerMTok: snap.outputPriceMicroUsdPerMTok / 1_000_000,
          overheadUsdPerMTok: snap.overheadPriceMicroUsdPerMTok / 1_000_000,
          contextMultiplier: snap.contextMultiplierMilli / 1000,
          priceTableVersion: snap.priceTableVersion,
        }
      : null,
    estimation: {
      estimator: snap.estimatorKey,
      estimatorVersion: snap.estimatorVersion,
      scope: snap.tokenScope,
      confidence: snap.confidence,
      computedAt: snap.computedAt,
    },
    referencePricingEnabled: enabled,
    isEstimated: true,
  };
}
