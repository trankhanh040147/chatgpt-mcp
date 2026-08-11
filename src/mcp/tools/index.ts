import { z } from "zod";
import type { TaskService } from "../../tasks/task.service.js";

const taskTypeSchema = z.enum([
  "research",
  "code_review",
  "architecture_review",
  "second_opinion",
  "debug_analysis",
]);

const contextSchema = z
  .object({
    objective: z.string().optional(),
    currentApproach: z.string().optional(),
    constraints: z.array(z.string()).optional(),
    relevantFiles: z.array(z.string()).optional(),
    gitDiff: z.string().optional(),
  })
  .optional();

export function registerHandoffTools(
  server: {
    tool: (
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>
    ) => void;
  },
  taskService: TaskService
): void {
  server.tool(
    "handoff_create_task",
    "Create a handoff task for external ChatGPT reasoning. Cursor agent use only.",
    {
      type: taskTypeSchema,
      prompt: z.string().min(1),
      context: contextSchema,
      cursorConversationId: z.string().optional(),
    },
    async (args) => {
      const conversationId = args.cursorConversationId as string | undefined;
      if (!conversationId) {
        throw new Error(
          "cursorConversationId is required (injected by preToolUse hook)"
        );
      }

      const result = taskService.createTask({
        type: args.type as Parameters<TaskService["createTask"]>[0]["type"],
        prompt: args.prompt as string,
        context: args.context as Parameters<TaskService["createTask"]>[0]["context"],
        cursorConversationId: conversationId,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "handoff_get_task",
    "Fetch a handoff task by ID. ChatGPT worker use only.",
    {
      taskId: z.string().min(1),
    },
    async (args) => {
      const task = taskService.getTask(args.taskId as string);
      if (!task) {
        throw new Error(`Task not found: ${args.taskId}`);
      }

      const output = {
        taskId: task.id,
        type: task.type,
        prompt: task.prompt,
        context: task.context ?? {},
        status: task.status,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  server.tool(
    "handoff_submit_result",
    "Submit the result for a handoff task. ChatGPT worker use only.",
    {
      taskId: z.string().min(1),
      result: z.string().min(1),
      metadata: z
        .object({
          summary: z.string().optional(),
          confidence: z.enum(["low", "medium", "high"]).optional(),
        })
        .optional(),
    },
    async (args) => {
      const output = taskService.submitResult({
        taskId: args.taskId as string,
        result: args.result as string,
        metadata: args.metadata as Parameters<
          TaskService["submitResult"]
        >[0]["metadata"],
      });

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  server.tool(
    "handoff_get_result",
    "Get the result of a completed handoff task. Cursor agent use only.",
    {
      taskId: z.string().min(1),
    },
    async (args) => {
      const output = taskService.getResult(args.taskId as string);
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  server.tool(
    "handoff_get_task_status",
    "Get the current status of a handoff task without returning the result.",
    {
      taskId: z.string().min(1),
    },
    async (args) => {
      const output = taskService.getTaskStatus(args.taskId as string);
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );
}
