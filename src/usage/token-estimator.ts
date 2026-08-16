import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { TokenEstimate, UsageConfidence } from "./usage.types.js";

const ESTIMATOR_KEY = "o200k_base";
const ESTIMATOR_VERSION = "js-tiktoken@1";

let enc: Tiktoken | null = null;

function encoding(): Tiktoken {
  if (!enc) enc = getEncoding("o200k_base");
  return enc;
}

/** UTF-8-aware char/4 fallback (not String.length / 4). */
export function estimateTokensChar4(text: string): number {
  if (!text) return 0;
  return Math.ceil(Array.from(text.normalize("NFC")).length / 4);
}

export function estimateTokensTiktoken(text: string): number {
  if (!text) return 0;
  return encoding().encode(text).length;
}

export function estimateTextTokens(
  text: string | null | undefined,
  uncertaintyPct = 30
): TokenEstimate {
  const raw = text ?? "";
  let tokens: number;
  let confidence: UsageConfidence = "medium";
  let estimatorKey = ESTIMATOR_KEY;
  let estimatorVersion = ESTIMATOR_VERSION;
  try {
    tokens = estimateTokensTiktoken(raw);
  } catch {
    tokens = estimateTokensChar4(raw);
    confidence = "low";
    estimatorKey = "char4_nfc";
    estimatorVersion = "fallback";
  }
  const pct = Math.min(100, Math.max(0, uncertaintyPct)) / 100;
  const low = Math.max(0, Math.floor(tokens * (1 - pct)));
  const high = Math.ceil(tokens * (1 + pct));
  return {
    tokens,
    low,
    high,
    estimatorKey,
    estimatorVersion,
    confidence,
  };
}

/**
 * Cross-provider (OpenAI tokenizer vs Claude counterfactual) → never high.
 */
export function blendConfidence(
  a: UsageConfidence,
  b: UsageConfidence,
  crossProvider: boolean
): UsageConfidence {
  if (crossProvider) return "low";
  if (a === "low" || b === "low") return "low";
  if (a === "medium" || b === "medium") return "medium";
  return "medium"; // never claim high without official usage object
}
