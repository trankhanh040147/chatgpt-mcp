import type { WorkerReadinessReason } from "../workers/chat-budget.js";

/** Probe / MCP write path failure — distinct from rotation/binding failure. */
export type ProbeMcpFailureReason =
  | "MCP_SAFETY_BLOCKED"
  | "MCP_APPROVAL_REQUIRED"
  | "MCP_TOOL_NOT_INVOKED"
  | "MCP_SUBMIT_TIMEOUT"
  | "PROBE_RESULT_MISMATCH";

export type McpDomHint =
  | "safety_blocked"
  | "approval_required"
  | "canary_in_chat"
  | null;

const PROBE_MCP_REASONS: ReadonlySet<ProbeMcpFailureReason> = new Set([
  "MCP_SAFETY_BLOCKED",
  "MCP_APPROVAL_REQUIRED",
  "MCP_TOOL_NOT_INVOKED",
  "MCP_SUBMIT_TIMEOUT",
  "PROBE_RESULT_MISMATCH",
]);

export function isProbeMcpFailureReason(
  reason: string | null | undefined
): reason is ProbeMcpFailureReason {
  return Boolean(reason && PROBE_MCP_REASONS.has(reason as ProbeMcpFailureReason));
}

export function classifyProbeFailure(input: {
  taskStatus: string;
  taskError?: string | null;
  domHint?: McpDomHint;
}): ProbeMcpFailureReason {
  const err = (input.taskError ?? "").toLowerCase();

  if (input.domHint === "safety_blocked" || err.includes("mcp_safety_blocked")) {
    return "MCP_SAFETY_BLOCKED";
  }
  if (
    input.domHint === "approval_required" ||
    err.includes("mcp_approval_required") ||
    err.includes("mcp write confirmation") ||
    err.includes("waiting_approval")
  ) {
    return "MCP_APPROVAL_REQUIRED";
  }
  if (err.includes("probe mismatch") || err.includes("probe_result_mismatch")) {
    return "PROBE_RESULT_MISMATCH";
  }
  if (
    input.taskStatus === "TIMED_OUT" ||
    err.includes("mcp_submit_timeout") ||
    err.includes("did not call handoff") ||
    err.includes("approval window") ||
    err.includes("hard timeout")
  ) {
    return "MCP_SUBMIT_TIMEOUT";
  }
  if (
    input.domHint === "canary_in_chat" ||
    err.includes("mcp_tool_not_invoked") ||
    err.includes("tool_not_invoked")
  ) {
    return "MCP_TOOL_NOT_INVOKED";
  }

  if (err.includes("safety") && err.includes("block")) {
    return "MCP_SAFETY_BLOCKED";
  }

  return "MCP_SUBMIT_TIMEOUT";
}

export function probeFailureToReadiness(
  reason: ProbeMcpFailureReason
): WorkerReadinessReason {
  return reason;
}

export function probeFailureOperatorMessage(reason: ProbeMcpFailureReason): string {
  switch (reason) {
    case "MCP_SAFETY_BLOCKED":
      return "MCP write blocked by OpenAI safety checks before remote-mcp (chat binding may still be OK)";
    case "MCP_APPROVAL_REQUIRED":
      return "MCP write needs approval in ChatGPT — allow handoff tools when prompted";
    case "MCP_TOOL_NOT_INVOKED":
      return "ChatGPT replied in chat but did not invoke the MCP write tool";
    case "MCP_SUBMIT_TIMEOUT":
      return "MCP write verification timed out — no submit received at remote-mcp";
    case "PROBE_RESULT_MISMATCH":
      return "MCP submit received but probe canary did not match";
  }
}

export function probeFailureDashboardBanner(reason: ProbeMcpFailureReason): {
  title: string;
  body: string;
  action: string;
} {
  switch (reason) {
    case "MCP_SAFETY_BLOCKED":
      return {
        title: "MCP safety blocked",
        body: "Chat binding succeeded but OpenAI blocked the write tool before remote-mcp.",
        action: "Try <em>New chat…</em> for a fresh conversation (do not nudge in-place).",
      };
    case "MCP_APPROVAL_REQUIRED":
      return {
        title: "MCP approval required",
        body: "Approve the handoff MCP write in ChatGPT, then <em>Retry verify</em>.",
        action: "Always allow reduces prompts but does not bypass safety blocks.",
      };
    case "MCP_TOOL_NOT_INVOKED":
      return {
        title: "MCP tool not invoked",
        body: "ChatGPT printed a reply without calling the MCP write tool.",
        action: "Try <em>New chat…</em> or <em>Retry verify</em>.",
      };
    case "MCP_SUBMIT_TIMEOUT":
      return {
        title: "MCP submit timeout",
        body: "No MCP write reached remote-mcp within the verification window.",
        action: "Check connector permissions; then <em>Retry verify</em> or <em>New chat…</em>.",
      };
    case "PROBE_RESULT_MISMATCH":
      return {
        title: "Probe result mismatch",
        body: "remote-mcp received a submit but the canary token did not match.",
        action: "<em>Retry verify</em> or <em>New chat…</em>.",
      };
  }
}
