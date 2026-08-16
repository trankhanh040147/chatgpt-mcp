import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { TaskService } from "../../tasks/task.service.js";
import { UNSCOPED_CLIENT_SESSION_ID } from "../../tasks/task.types.js";
import {
  SUBMIT_POLICY,
  SUBMIT_RESULT_TOOL_DESCRIPTION,
} from "../worker-policy.js";

const MAX_PROMPT = 100_000;
const MAX_RESULT = 200_000;
const MAX_SUMMARY = 2_000;

const taskTypeSchema = z.enum([
  "research",
  "code_review",
  "architecture_review",
  "second_opinion",
  "debug_analysis",
]);

const taskIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^ho_[A-Z0-9]+$/i, "taskId must look like ho_…");

const contextSchema = z
  .object({
    objective: z.string().max(10_000).optional(),
    currentApproach: z.string().max(20_000).optional(),
    constraints: z.array(z.string().max(2_000)).max(50).optional(),
    relevantFiles: z.array(z.string().max(1_000)).max(100).optional(),
    gitDiff: z.string().max(100_000).optional(),
  })
  .optional();

type ToolRegistrar = {
  tool: (
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    annotations: ToolAnnotations,
    handler: (
      args: Record<string, unknown>
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>
  ) => void;
};

function jsonContent(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function registerHandoffTools(
  server: ToolRegistrar,
  taskService: TaskService
): void {
  server.tool(
    "handoff_create_task",
    "Create a handoff task for external ChatGPT reasoning. Returns taskId (authoritative). "
      + "Optional clientSessionId / cursorConversationId correlates to the host chat (Cursor hooks inject). "
      + "In Cursor: end the turn after create — do not poll status; the stop hook resumes you for handoff_get_result. "
      + "Do not enumerate tasks.",
    {
      type: taskTypeSchema,
      prompt: z.string().min(1).max(MAX_PROMPT),
      context: contextSchema,
      clientSessionId: z.string().min(1).max(200).optional(),
      cursorConversationId: z
        .string()
        .max(200)
        .optional()
        .describe("Deprecated alias for clientSessionId (Cursor preToolUse)"),
    },
    {
      title: "Create handoff task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (args) => {
      const rawSession =
        (args.clientSessionId as string | undefined)?.trim() ||
        (args.cursorConversationId as string | undefined)?.trim() ||
        "";
      const clientSessionId = rawSession || UNSCOPED_CLIENT_SESSION_ID;
      const scoped = clientSessionId !== UNSCOPED_CLIENT_SESSION_ID;

      const result = taskService.createTask({
        type: args.type as Parameters<TaskService["createTask"]>[0]["type"],
        prompt: args.prompt as string,
        context: args.context as Parameters<TaskService["createTask"]>[0]["context"],
        cursorConversationId: clientSessionId,
      });

      return jsonContent({
        ...result,
        clientSessionId,
        scoped,
        agentHint: scoped
          ? "Cursor: end your turn NOW. Do NOT poll handoff_get_task_status. "
            + "The stop hook will resume you; then call handoff_get_result only."
          : "No host session id — retain taskId and poll handoff_get_task_status, then handoff_get_result. "
            + "Stop-hook auto-resume will not attach to this task.",
      });
    }
  );

  server.tool(
    "handoff_get_task",
    "Fetch one handoff task by exact TASK_ID from the chat. ChatGPT worker use only. Never guess or list IDs.",
    {
      taskId: taskIdSchema,
    },
    {
      title: "Get handoff task",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async (args) => {
      const task = taskService.getTask(args.taskId as string);
      if (!task) {
        throw new Error(`Task not found: ${args.taskId}`);
      }

      return jsonContent({
        taskId: task.id,
        type: task.type,
        prompt: task.prompt,
        context: task.context ?? {},
        status: task.status,
        submitPolicy: {
          ...SUBMIT_POLICY,
          lateSubmitAccepted: task.status === "TIMED_OUT" && !task.result,
        },
      });
    }
  );

  server.tool(
    "handoff_submit_result",
    SUBMIT_RESULT_TOOL_DESCRIPTION,
    {
      taskId: taskIdSchema,
      result: z.string().min(1).max(MAX_RESULT),
      metadata: z
        .object({
          summary: z.string().max(MAX_SUMMARY).optional(),
          confidence: z.enum(["low", "medium", "high"]).optional(),
        })
        .optional(),
    },
    {
      title: "Submit handoff result",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (args) => {
      const output = taskService.submitResult({
        taskId: args.taskId as string,
        result: args.result as string,
        metadata: args.metadata as Parameters<
          TaskService["submitResult"]
        >[0]["metadata"],
      });

      return jsonContent(output);
    }
  );

  server.tool(
    "handoff_get_result",
    "Get the result of a completed handoff task. Cursor agent use only.",
    {
      taskId: taskIdSchema,
    },
    {
      title: "Get handoff result",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async (args) => {
      const output = taskService.getResult(args.taskId as string);
      return jsonContent(output);
    }
  );

  server.tool(
    "handoff_get_task_status",
    "Get the current status of a handoff task without returning the result body. "
      + "Prefer the Cursor stop hook instead of polling this in a loop when the hook is available.",
    {
      taskId: taskIdSchema,
    },
    {
      title: "Get handoff status",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async (args) => {
      const output = taskService.getTaskStatus(args.taskId as string);
      return jsonContent(output);
    }
  );
}
