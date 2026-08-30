import { chatIdFromUrl } from "../browser/chat-url.js";
import type { BrokerStatusSnapshot } from "./broker-client.js";
import {
  deriveWorkerIndicators,
  sanitizeChatUrl,
  type WorkerIndicator,
} from "../dashboard/observability.js";
import { isProbeMcpFailureReason } from "../mcp/probe-failure.js";
import type { TaskRepository } from "../tasks/task.repository.js";

export type WorkerConditionType =
  | "PROCESS"
  | "BROKER"
  | "BINDING"
  | "URL"
  | "SESSION"
  | "MCP";

export type ConditionStatus = "TRUE" | "FALSE" | "UNKNOWN";

export interface WorkerCondition {
  type: WorkerConditionType;
  status: ConditionStatus;
  reason: string;
  message?: string;
  observedAt: string;
}

export type WorkerHealthState =
  | "READY"
  | "DEGRADED"
  | "BLOCKED"
  | "OFFLINE"
  | "UNKNOWN";

export type RecommendedAction =
  | "NONE"
  | "RETRY_VERIFY"
  | "RECREATE_CHAT"
  | "LOGIN_CHATGPT"
  | "START_BROKER"
  | "ASSIGN_URL";

export interface WorkerHealthRow {
  id: string;
  healthState: WorkerHealthState;
  conditions: WorkerCondition[];
  recommendedAction: RecommendedAction;
  indicators: WorkerIndicator[];
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (pid == null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function buildWorkerHealthRow(input: {
  worker: ReturnType<TaskRepository["getWorkerState"]>;
  brokerStatus: BrokerStatusSnapshot | null;
  brokerReachable: boolean;
  staleMs: number;
  now?: number;
}): WorkerHealthRow {
  const now = input.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const w = input.worker;
  const conditions: WorkerCondition[] = [];

  const pidAlive = isPidAlive(w.pid);
  conditions.push({
    type: "PROCESS",
    status: pidAlive ? "TRUE" : "FALSE",
    reason: pidAlive ? "pid_alive" : "pid_dead",
    observedAt: nowIso,
  });

  const brokerOk = input.brokerReachable && input.brokerStatus?.healthy;
  conditions.push({
    type: "BROKER",
    status: brokerOk ? "TRUE" : input.brokerReachable ? "FALSE" : "UNKNOWN",
    reason: brokerOk ? "broker_healthy" : "broker_unreachable",
    observedAt: nowIso,
  });

  const binding = input.brokerStatus?.bindings.find((b) => b.workerId === w.id);
  conditions.push({
    type: "BINDING",
    status: binding ? "TRUE" : "FALSE",
    reason: binding ? "tab_bound" : "unbound",
    observedAt: nowIso,
  });

  const registryUrl = sanitizeChatUrl(w.workerUrl);
  const urlMatch =
    binding &&
    registryUrl &&
    chatIdFromUrl(binding.pageUrl) === chatIdFromUrl(registryUrl);
  conditions.push({
    type: "URL",
    status: urlMatch ? "TRUE" : registryUrl ? "FALSE" : "UNKNOWN",
    reason: urlMatch ? "url_match" : "url_mismatch",
    observedAt: nowIso,
  });

  const sessionReady = w.status !== "SESSION_LOST";
  conditions.push({
    type: "SESSION",
    status: sessionReady ? "TRUE" : "FALSE",
    reason: sessionReady ? "session_ok" : "session_lost",
    message: sessionReady
      ? "runtime has not reported SESSION_LOST (not an active browser probe)"
      : "SESSION_LOST reported by worker runtime",
    observedAt: nowIso,
  });

  const mcpProbeFailure = isProbeMcpFailureReason(w.readinessReason);
  const mcpReady =
    !w.readinessReason || w.readinessReason === "THRESHOLD_REACHED";
  conditions.push({
    type: "MCP",
    status: mcpReady ? "TRUE" : "FALSE",
    reason: w.readinessReason ?? "ready",
    message: w.readinessReason
      ? w.error ?? w.readinessReason
      : "MCP write path verified",
    observedAt: nowIso,
  });

  let healthState: WorkerHealthState = "UNKNOWN";
  if (!pidAlive || w.status === "ERROR") {
    healthState = "OFFLINE";
  } else if (
    w.readinessReason === "CONSENT_REQUIRED" ||
    w.readinessReason === "MCP_APPROVAL_REQUIRED" ||
    w.status === "SESSION_LOST"
  ) {
    healthState = "BLOCKED";
  } else if (!brokerOk || !binding || !urlMatch) {
    healthState = "DEGRADED";
  } else if (mcpProbeFailure) {
    healthState = "DEGRADED";
  } else if (mcpReady && sessionReady) {
    healthState = "READY";
  } else {
    healthState = "DEGRADED";
  }

  let recommendedAction: RecommendedAction = "NONE";
  if (!brokerOk) recommendedAction = "START_BROKER";
  else if (w.status === "SESSION_LOST") recommendedAction = "RECREATE_CHAT";
  else if (
    w.readinessReason === "CONSENT_REQUIRED" ||
    w.readinessReason === "MCP_APPROVAL_REQUIRED"
  ) {
    recommendedAction = "RETRY_VERIFY";
  } else if (w.readinessReason === "MCP_SAFETY_BLOCKED") {
    recommendedAction = "RECREATE_CHAT";
  } else if (mcpProbeFailure) {
    recommendedAction = "RETRY_VERIFY";
  } else if (!binding || !urlMatch) recommendedAction = "ASSIGN_URL";

  const lastSeenMs = w.lastSeenAt ? Date.parse(w.lastSeenAt) : Number.NaN;
  const heartbeatStale =
    !Number.isFinite(lastSeenMs) || now - lastSeenMs > input.staleMs;

  const indicators = deriveWorkerIndicators({
    status: w.status,
    healthy: pidAlive && !heartbeatStale,
    pidAlive,
    heartbeatStale,
    heartbeatAgeMs: Number.isFinite(lastSeenMs) ? now - lastSeenMs : null,
    currentTaskAgeMs: null,
    recentFailed: 0,
    recentTimedOut: 0,
    readinessReason: w.readinessReason,
    chatBudgetWarn: false,
    chatBudgetExhausted: false,
  });

  return {
    id: w.id,
    healthState,
    conditions,
    recommendedAction,
    indicators,
  };
}
