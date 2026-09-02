import { chatIdFromUrl } from "../browser/chat-url.js";
import type { BrokerStatusSnapshot } from "./broker-client.js";
import {
  deriveWorkerIndicators,
  sanitizeChatUrl,
  type WorkerIndicator,
} from "../dashboard/observability.js";
import type { TaskRepository } from "../tasks/task.repository.js";

export type WorkerConditionType =
  | "PROCESS"
  | "BROKER"
  | "BINDING"
  | "URL"
  | "SESSION"
  | "MCP_READ"
  | "MCP_WRITE";

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

/** Operator-visible lifecycle — hides VERIFYING/BUSY/handoff as peer states. */
export type OperatorState =
  | "STARTING"
  | "READY"
  | "ACTION_REQUIRED"
  | "DEGRADED"
  | "ERROR";

export type OperatorAction =
  | "NONE"
  | "CONTINUE"
  | "ASSIGN_URL"
  | "NEW_CHAT"
  | "LOGIN_CHATGPT"
  | "START_BROKER"
  | "RECREATE_CHAT";

export interface WorkerHealthRow {
  id: string;
  healthState: WorkerHealthState;
  operatorState: OperatorState;
  operatorAction: OperatorAction;
  operatorDetail: string;
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

function infrastructureReadinessBlocks(
  reason: string | null | undefined
): boolean {
  return Boolean(
    reason &&
      (reason === "THRESHOLD_REACHED" ||
        reason === "ROTATION_PENDING" ||
        reason === "ROTATION_FAILED" ||
        reason === "RESTART_REQUIRED")
  );
}

export function deriveOperatorPresentation(input: {
  worker: {
    status: string;
    readinessReason: string | null;
    error: string | null;
    mcpWriteStatus?: string | null;
  };
  healthState: WorkerHealthState;
  recommendedAction: RecommendedAction;
  activeOperation?: { state: string; kind: string } | null;
  brokerReachable: boolean;
  heartbeatStale?: boolean;
  pinnedTerminalTaskId?: string | null;
}): {
  operatorState: OperatorState;
  operatorAction: OperatorAction;
  operatorDetail: string;
} {
  const w = input.worker;
  const rr = w.readinessReason;

  if (input.healthState === "OFFLINE" || w.status === "ERROR") {
    const needsSetup =
      input.recommendedAction === "ASSIGN_URL" ||
      (w.error ?? "").includes("PENDING_SETUP");
    return {
      operatorState: "ERROR",
      operatorAction: needsSetup
        ? "NEW_CHAT"
        : input.recommendedAction === "START_BROKER"
          ? "START_BROKER"
          : input.recommendedAction === "ASSIGN_URL"
            ? "NEW_CHAT"
            : "NONE",
      operatorDetail: needsSetup
        ? "Registered — opening ChatGPT tab (New chat). Watch CDP Chrome."
        : w.error ?? w.status,
    };
  }

  if (
    input.activeOperation &&
    input.activeOperation.state !== "SUCCEEDED" &&
    input.activeOperation.state !== "FAILED"
  ) {
    return {
      operatorState: "STARTING",
      operatorAction: "NONE",
      operatorDetail: "Connecting worker chat",
    };
  }

  if (input.pinnedTerminalTaskId) {
    return {
      operatorState: "DEGRADED",
      operatorAction: "CONTINUE",
      operatorDetail:
        "Completed handoff still pinned — worker cannot claim queue",
    };
  }

  if (input.heartbeatStale && input.healthState === "READY") {
    return {
      operatorState: "DEGRADED",
      operatorAction: "NONE",
      operatorDetail: "Heartbeat stale — not claiming new handoffs",
    };
  }

  if (input.healthState === "READY") {
    return {
      operatorState: "READY",
      operatorAction: "NONE",
      operatorDetail:
        w.mcpWriteStatus === "DEGRADED"
          ? "Worker ready — MCP write degraded (platform safety)"
          : "Worker ready for handoffs",
    };
  }

  if (rr === "MCP_APPROVAL_REQUIRED" || w.status === "SESSION_LOST") {
    const action: OperatorAction =
      w.status === "SESSION_LOST"
        ? "LOGIN_CHATGPT"
        : input.recommendedAction === "RECREATE_CHAT"
          ? "NEW_CHAT"
          : "CONTINUE";
    return {
      operatorState: "ACTION_REQUIRED",
      operatorAction: action,
      operatorDetail:
        rr === "MCP_APPROVAL_REQUIRED"
          ? "Approve MCP writes in ChatGPT, then Continue"
          : "Log into ChatGPT in CDP Chrome",
    };
  }

  if (input.healthState === "DEGRADED" || input.healthState === "BLOCKED") {
    let action: OperatorAction = "NONE";
    if (!input.brokerReachable) action = "START_BROKER";
    else if (input.recommendedAction === "ASSIGN_URL") action = "ASSIGN_URL";
    else if (input.recommendedAction === "RECREATE_CHAT") action = "NEW_CHAT";
    else if (input.recommendedAction === "RETRY_VERIFY") action = "CONTINUE";

    return {
      operatorState: "DEGRADED",
      operatorAction: action,
      operatorDetail: w.error ?? rr ?? input.healthState,
    };
  }

  return {
    operatorState: "DEGRADED",
    operatorAction:
      input.recommendedAction === "START_BROKER" ? "START_BROKER" : "ASSIGN_URL",
    operatorDetail: w.error ?? rr ?? "unknown",
  };
}

export function buildWorkerHealthRow(input: {
  worker: ReturnType<TaskRepository["getWorkerState"]>;
  brokerStatus: BrokerStatusSnapshot | null;
  brokerReachable: boolean;
  staleMs: number;
  activeOperation?: { state: string; kind: string } | null;
  pinnedTerminalTaskId?: string | null;
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

  const mcpReadOk = Boolean(w.mcpReadVerifiedAt);
  conditions.push({
    type: "MCP_READ",
    status: mcpReadOk ? "TRUE" : "UNKNOWN",
    reason: mcpReadOk ? "read_verified" : "unverified",
    message: mcpReadOk
      ? `handoff_get_task @ ${w.mcpReadVerifiedAt}`
      : "No successful handoff_get_task yet",
    observedAt: nowIso,
  });

  const mcpWriteVerified = Boolean(w.mcpWriteVerifiedAt);
  const mcpWriteDegraded = w.mcpWriteStatus === "DEGRADED";
  conditions.push({
    type: "MCP_WRITE",
    status: mcpWriteVerified
      ? "TRUE"
      : mcpWriteDegraded
        ? "FALSE"
        : "UNKNOWN",
    reason: mcpWriteVerified
      ? "write_verified"
      : mcpWriteDegraded
        ? "write_degraded"
        : "unverified",
    message: mcpWriteVerified
      ? `handoff_submit_result @ ${w.mcpWriteVerifiedAt}`
      : mcpWriteDegraded
        ? w.mcpWriteStatusReason ?? "MCP write degraded"
        : "No successful MCP write yet (not blocking READY)",
    observedAt: nowIso,
  });

  let healthState: WorkerHealthState = "UNKNOWN";
  if (!pidAlive || w.status === "ERROR") {
    healthState = "OFFLINE";
  } else if (
    w.readinessReason === "MCP_APPROVAL_REQUIRED" ||
    w.status === "SESSION_LOST" ||
    infrastructureReadinessBlocks(w.readinessReason)
  ) {
    healthState =
      w.readinessReason === "ROTATION_PENDING" ||
      w.readinessReason === "MCP_APPROVAL_REQUIRED"
        ? "BLOCKED"
        : "DEGRADED";
  } else if (!brokerOk || !binding || !urlMatch) {
    healthState = "DEGRADED";
  } else if (sessionReady) {
    healthState = "READY";
  } else {
    healthState = "DEGRADED";
  }

  const lastSeenMs = w.lastSeenAt ? Date.parse(w.lastSeenAt) : Number.NaN;
  const heartbeatStale =
    !Number.isFinite(lastSeenMs) || now - lastSeenMs > input.staleMs;

  let recommendedAction: RecommendedAction = "NONE";
  if (!brokerOk) recommendedAction = "START_BROKER";
  else if (w.status === "SESSION_LOST") recommendedAction = "RECREATE_CHAT";
  else if (w.readinessReason === "MCP_APPROVAL_REQUIRED") {
    recommendedAction = "RETRY_VERIFY";
  } else if (!binding || !urlMatch) recommendedAction = "ASSIGN_URL";

  const operator = deriveOperatorPresentation({
    worker: {
      status: w.status,
      readinessReason: w.readinessReason ?? null,
      error: w.error ?? null,
      mcpWriteStatus: w.mcpWriteStatus,
    },
    healthState,
    recommendedAction,
    activeOperation: input.activeOperation,
    brokerReachable: input.brokerReachable,
    heartbeatStale,
    pinnedTerminalTaskId: input.pinnedTerminalTaskId ?? null,
  });

  if (input.pinnedTerminalTaskId) {
    healthState = "DEGRADED";
  } else if (heartbeatStale && healthState === "READY") {
    healthState = "DEGRADED";
  }

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
    operatorState: operator.operatorState,
    operatorAction: operator.operatorAction,
    operatorDetail: operator.operatorDetail,
    conditions,
    recommendedAction,
    indicators,
  };
}
