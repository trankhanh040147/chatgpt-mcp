/**
 * Policies ChatGPT sees on the remote/stdio MCP connector.
 * Keep instructions boring — defensive authorization language can worsen soft-refuse.
 */

/** Server-level instructions for both stdio and remote MCP. */
export const WORKER_MCP_INSTRUCTIONS =
  "Use the task ID provided in the chat. " +
  "Read that task with handoff_get_task. " +
  "Complete the requested work. " +
  "Return the result using handoff_submit_result for the same task ID. " +
  "For system connectivity checks, use handoff_ack with the task ID only.";

/** Tool description for handoff_submit_result (ChatGPT worker). */
export const SUBMIT_RESULT_TOOL_DESCRIPTION =
  "Return the completed task result. Optional artifacts[] writes workspace files " +
  "(relative path + UTF-8 content); fail-closed on invalid paths or secrets.";

/** Attached to handoff_get_task payload. */
export const SUBMIT_POLICY = {
  completionTool: "handoff_submit_result",
  taskId: "Use the current task ID from the chat message.",
} as const;

/** Playwright nudge when ChatGPT has not submitted within ~30s. */
export const SUBMIT_NUDGE_MESSAGE = (taskId: string): string =>
  `Complete TASK_ID=${taskId} using handoff_submit_result.`;

/** Minimal tool description for handoff_complete_probe (legacy; prefer handoff_ack). */
export const PROBE_COMPLETE_TOOL_DESCRIPTION =
  "Complete a system connectivity check for the given task ID.";

/** Ack-only probe tool (no canary in schema). */
export const PROBE_ACK_TOOL_DESCRIPTION =
  "Acknowledge a system connectivity check for the given task ID.";

/** get_task policy for SYSTEM_PROBE tasks. */
export const PROBE_GET_TASK_SUBMIT_POLICY = {
  completionTool: "handoff_ack",
  taskId: "Use the task ID from the chat message.",
} as const;

/** SYSTEM_PROBE nudge — one line, no token/canary wording. */
export const PROBE_SUBMIT_NUDGE_MESSAGE = (taskId: string): string =>
  `Complete TASK_ID=${taskId} using handoff_ack.`;
