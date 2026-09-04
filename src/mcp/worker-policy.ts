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
  "Submit the completed task result. " +
  "When modifying or creating workspace files, pass artifacts[] (max 20) with complete final UTF-8 bodies, " +
  "OR archive={format:'tar.zst',encoding:'base64',data} for larger batches (max 100 members) — never both. " +
  "Prose in result does NOT write to disk. " +
  "overwrite replaces an existing/attached file; create adds a new path (default) for artifacts[]. " +
  "Archive members upsert. Writes are validated then committed as one batch. " +
  "Limits: artifacts 20/32MiB/128MiB; archive 100/64MiB/64MiB compressed. result must always be non-empty.";

/** Per-task behavioral guidance for writeback (decision-oriented, not runtime rules). */
export const WRITEBACK_POLICY = {
  whenToWrite: [
    "Write an artifact only when you can provide the complete final file content.",
    "For ≤20 files prefer artifacts[]; for larger batches use archive tar.zst.",
    "Never send both artifacts[] and archive.",
    "For an attached/existing workspace file via artifacts[], use mode=overwrite.",
    "For a new workspace path via artifacts[], use mode=create.",
    "If the change cannot be safely represented as a complete final file, do not emit an artifact; describe it in result instead.",
  ],
  submission: [
    "When you modified or created workspace files, artifacts[] or archive is required — result prose alone does not write bytes.",
    "Writes are validated and committed as one batch. Validation failures write nothing.",
    "If a commit fails, the server rolls back that batch before returning an error.",
    "Always provide a non-empty result summarizing files written and any prose-only changes.",
  ],
  onRejection: [
    "If submission is rejected, assume no write from that batch was accepted.",
    "Correct the reported problem and retry only if it can be corrected safely.",
    "On create collision (target exists): do NOT automatically switch to overwrite — report conflict or use prose-only.",
  ],
} as const;

/** Attached to handoff_get_task payload. */
export const SUBMIT_POLICY = {
  completionTool: "handoff_submit_result",
  taskId: "Use the current task ID from the chat message.",
} as const;

/** Playwright nudge when ChatGPT has not submitted within ~30s. */
export const SUBMIT_NUDGE_MESSAGE = (
  taskId: string,
  opts?: { hasAttachedFiles?: boolean; preferArchive?: boolean }
): string => {
  if (opts?.preferArchive) {
    return (
      `Complete TASK_ID=${taskId} using handoff_submit_result with submitTemplate.archive ` +
      `(format/encoding/data) — do not invent artifacts[].`
    );
  }
  return opts?.hasAttachedFiles
    ? `Complete TASK_ID=${taskId} using handoff_submit_result with artifacts[] (complete file bodies) for each file you changed.`
    : `Complete TASK_ID=${taskId} using handoff_submit_result.`;
};

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
