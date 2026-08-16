import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blendConfidence,
  estimateTextTokens,
} from "./token-estimator.js";
import type {
  CostConfig,
  PriceTableFile,
  TaskUsageSnapshot,
} from "./usage.types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultPriceTablePath(): string {
  const candidates = [
    process.env.HANDOFF_COST_PRICE_TABLE?.trim(),
    join(process.cwd(), "config/model-prices.json"),
    join(process.cwd(), "dist/config/model-prices.json"),
    join(__dirname, "../../config/model-prices.json"),
    join(__dirname, "../../dist/config/model-prices.json"),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    const abs = resolve(p);
    if (existsSync(abs)) return abs;
  }
  return resolve(join(process.cwd(), "config/model-prices.json"));
}

function loadPriceTable(): PriceTableFile {
  const path = defaultPriceTablePath();
  const raw = JSON.parse(readFileSync(path, "utf-8")) as PriceTableFile;
  if (!raw.version || !raw.models || !raw.defaultModel) {
    throw new Error(`Invalid price table: ${path}`);
  }
  if (!raw.models[raw.defaultModel]) {
    throw new Error(
      `Price table defaultModel missing in models: ${raw.defaultModel}`
    );
  }
  return raw;
}

function usdToMicroPerMTok(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`Invalid USD/MTok rate: ${usd}`);
  }
  return Math.round(usd * 1_000_000);
}

/** microUsd = tokens * (microUsdPerMTok) / 1_000_000 */
export function costMicroUsd(
  inputTokens: number,
  outputTokens: number,
  inputMicroPerMTok: number,
  outputMicroPerMTok: number,
  overheadMicroPerMTok: number,
  contextMultiplierMilli: number
): number {
  const adjIn = Math.floor(
    (inputTokens * Math.max(1000, contextMultiplierMilli)) / 1000
  );
  const inCost = (BigInt(adjIn) * BigInt(inputMicroPerMTok)) / 1_000_000n;
  const outCost =
    (BigInt(outputTokens) * BigInt(outputMicroPerMTok)) / 1_000_000n;
  const ohCost =
    (BigInt(adjIn + outputTokens) * BigInt(overheadMicroPerMTok)) /
    1_000_000n;
  return Number(inCost + outCost + ohCost);
}

export function microToUsd(micro: number): number {
  return Math.round(micro) / 1_000_000;
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0.005) return "<$0.01";
  if (usd < 10) return `≈$${usd.toFixed(2)}`;
  return `≈$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `≈${n}`;
  if (n < 10_000) return `≈${(n / 1000).toFixed(1)}k`;
  return `≈${Math.round(n / 1000)}k`;
}

let cachedConfig: CostConfig | null = null;
let warnedLegacy = false;

/**
 * Reference $ comparison is opt-in.
 * - HANDOFF_REFERENCE_PRICING=on|off (explicit)
 * - legacy: HANDOFF_COST_MODEL set → on
 * - default: off (tokens only in UI)
 */
export function isReferencePricingEnabled(): boolean {
  const flag = process.env.HANDOFF_REFERENCE_PRICING?.trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false" || flag === "no") {
    return false;
  }
  if (flag === "on" || flag === "1" || flag === "true" || flag === "yes") {
    return true;
  }
  return Boolean(process.env.HANDOFF_COST_MODEL?.trim());
}

export function scenarioDisplayName(
  modelKey: string,
  entry: { label: string; displayName?: string }
): string {
  return entry.displayName?.trim() || `Cursor alternative · ${entry.label}`;
}

export function loadCostConfig(force = false): CostConfig {
  if (cachedConfig && !force) return cachedConfig;
  const table = loadPriceTable();
  const scenarioEnv =
    process.env.HANDOFF_REFERENCE_SCENARIO?.trim() ||
    process.env.HANDOFF_COST_MODEL?.trim();
  const modelKey = scenarioEnv || table.defaultModel;
  const entry = table.models[modelKey];
  if (!entry) {
    throw new Error(`Unknown reference scenario / HANDOFF_COST_MODEL: ${modelKey}`);
  }

  const inputOverride = process.env.HANDOFF_COST_INPUT_USD_PER_MTOK;
  const outputOverride = process.env.HANDOFF_COST_OUTPUT_USD_PER_MTOK;
  const overheadRaw = process.env.HANDOFF_COST_OVERHEAD_USD_PER_MTOK ?? "0";
  const multRaw = process.env.HANDOFF_COST_CONTEXT_MULTIPLIER ?? "1";
  const uncRaw = process.env.HANDOFF_TOKEN_UNCERTAINTY_PCT ?? "30";

  const inputUsd = inputOverride
    ? Number(inputOverride)
    : entry.inputUsdPerMTok;
  const outputUsd = outputOverride
    ? Number(outputOverride)
    : entry.outputUsdPerMTok;
  const overheadUsd = Number(overheadRaw);
  const contextMultiplier = Number(multRaw);
  const uncertaintyPct = Number(uncRaw);

  if (
    ![inputUsd, outputUsd, overheadUsd, contextMultiplier, uncertaintyPct].every(
      (n) => Number.isFinite(n)
    )
  ) {
    throw new Error("Invalid HANDOFF_COST_* numeric env");
  }
  if (inputUsd < 0 || outputUsd < 0 || overheadUsd < 0) {
    throw new Error("HANDOFF_COST rates must be ≥ 0");
  }
  if (contextMultiplier < 1) {
    throw new Error("HANDOFF_COST_CONTEXT_MULTIPLIER must be ≥ 1");
  }
  if (uncertaintyPct < 0 || uncertaintyPct > 100) {
    throw new Error("HANDOFF_TOKEN_UNCERTAINTY_PCT must be 0–100");
  }

  const version =
    process.env.HANDOFF_COST_PRICE_TABLE_VERSION?.trim() || table.version;
  const referencePricingEnabled = isReferencePricingEnabled();

  if (
    !warnedLegacy &&
    process.env.HANDOFF_COST_MODEL?.trim() &&
    !process.env.HANDOFF_REFERENCE_PRICING?.trim()
  ) {
    warnedLegacy = true;
    console.warn(
      "[usage] HANDOFF_COST_MODEL enables reference pricing (legacy). Prefer HANDOFF_REFERENCE_PRICING=on and HANDOFF_REFERENCE_SCENARIO=…. This is not the ChatGPT runtime model."
    );
  }

  cachedConfig = {
    modelKey,
    modelLabel: entry.label,
    scenarioDisplayName: scenarioDisplayName(modelKey, entry),
    priceTableVersion: version,
    inputUsdPerMTok: inputUsd,
    outputUsdPerMTok: outputUsd,
    overheadUsdPerMTok: overheadUsd,
    contextMultiplier,
    estimatorKey: "o200k_base",
    estimatorVersion: "js-tiktoken@1",
    uncertaintyPct,
    referencePricingEnabled,
  };
  return cachedConfig;
}

export function estimateTaskUsage(
  prompt: string,
  result: string,
  config: CostConfig = loadCostConfig()
): TaskUsageSnapshot {
  const inEst = estimateTextTokens(prompt, config.uncertaintyPct);
  const outEst = estimateTextTokens(result, config.uncertaintyPct);
  const crossProvider = !config.modelKey.startsWith("gpt-");
  const confidence = blendConfidence(
    inEst.confidence,
    outEst.confidence,
    crossProvider || config.contextMultiplier !== 1
  );

  const inputMicro = usdToMicroPerMTok(config.inputUsdPerMTok);
  const outputMicro = usdToMicroPerMTok(config.outputUsdPerMTok);
  const overheadMicro = usdToMicroPerMTok(config.overheadUsdPerMTok);
  const multMilli = Math.round(config.contextMultiplier * 1000);

  const mid = costMicroUsd(
    inEst.tokens,
    outEst.tokens,
    inputMicro,
    outputMicro,
    overheadMicro,
    multMilli
  );
  const low = costMicroUsd(
    inEst.low,
    outEst.low,
    inputMicro,
    outputMicro,
    overheadMicro,
    multMilli
  );
  const high = costMicroUsd(
    inEst.high,
    outEst.high,
    inputMicro,
    outputMicro,
    overheadMicro,
    multMilli
  );

  return {
    inputTokensEst: inEst.tokens,
    outputTokensEst: outEst.tokens,
    totalTokensEst: inEst.tokens + outEst.tokens,
    inputTokensLow: inEst.low,
    inputTokensHigh: inEst.high,
    outputTokensLow: outEst.low,
    outputTokensHigh: outEst.high,
    estimatorKey: inEst.estimatorKey,
    estimatorVersion: inEst.estimatorVersion,
    tokenScope: "stored_prompt_result_text_only",
    confidence,
    counterfactualModel: config.modelKey,
    priceTableVersion: config.priceTableVersion,
    inputPriceMicroUsdPerMTok: inputMicro,
    outputPriceMicroUsdPerMTok: outputMicro,
    overheadPriceMicroUsdPerMTok: overheadMicro,
    contextMultiplierMilli: multMilli,
    apiEquivAvoidedMicroUsd: mid,
    apiEquivAvoidedLowMicroUsd: low,
    apiEquivAvoidedHighMicroUsd: high,
    subscriptionAllocatedMicroUsd: null,
    cashSavedMicroUsd: null,
    computedAt: new Date().toISOString(),
  };
}
