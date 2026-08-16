export type UsageConfidence = "low" | "medium" | "high";

export interface ModelPriceEntry {
  label: string;
  /** Operator-facing scenario name (not runtime model). */
  displayName?: string;
  context?: "counterfactual";
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface PriceTableFile {
  version: string;
  notes?: string;
  defaultModel: string;
  models: Record<string, ModelPriceEntry>;
}

export interface CostConfig {
  modelKey: string;
  modelLabel: string;
  /** e.g. "Cursor alternative · Claude Sonnet 5" */
  scenarioDisplayName: string;
  priceTableVersion: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  overheadUsdPerMTok: number;
  contextMultiplier: number;
  estimatorKey: string;
  estimatorVersion: string;
  uncertaintyPct: number;
  /** When false, UI shows tokens only; $ is optional reference. */
  referencePricingEnabled: boolean;
}

export interface TokenEstimate {
  tokens: number;
  low: number;
  high: number;
  estimatorKey: string;
  estimatorVersion: string;
  confidence: UsageConfidence;
}

export interface TaskUsageSnapshot {
  inputTokensEst: number;
  outputTokensEst: number;
  totalTokensEst: number;
  inputTokensLow: number;
  inputTokensHigh: number;
  outputTokensLow: number;
  outputTokensHigh: number;
  estimatorKey: string;
  estimatorVersion: string;
  tokenScope: "stored_prompt_result_text_only";
  confidence: UsageConfidence;
  counterfactualModel: string;
  priceTableVersion: string;
  inputPriceMicroUsdPerMTok: number;
  outputPriceMicroUsdPerMTok: number;
  overheadPriceMicroUsdPerMTok: number;
  contextMultiplierMilli: number;
  apiEquivAvoidedMicroUsd: number;
  apiEquivAvoidedLowMicroUsd: number;
  apiEquivAvoidedHighMicroUsd: number;
  subscriptionAllocatedMicroUsd: null;
  cashSavedMicroUsd: null;
  computedAt: string;
}

export interface UsageWindowAgg {
  completedTasks: number;
  measuredTasks: number;
  estimatedTokens: number;
  apiEquivalentAvoidedUsd: number;
}

export interface UsageAggBundle {
  last24h: UsageWindowAgg;
  allTime: UsageWindowAgg;
}
