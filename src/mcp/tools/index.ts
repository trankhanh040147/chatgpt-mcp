import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { TaskService } from "../../tasks/task.service.js";
import {
  HandoffFileError,
  UNSCOPED_CLIENT_SESSION_ID,
} from "../../tasks/task.types.js";
import {
  MAX_ARTIFACTS_PER_SUBMIT,
} from "../../tasks/result-artifacts.js";
import { MAX_BYTES_PER_FILE } from "../../tasks/files.js";
import { ArchiveError } from "../../archive/errors.js";
import {
  PROBE_ACK_TOOL_DESCRIPTION,
  PROBE_COMPLETE_TOOL_DESCRIPTION,
  PROBE_GET_TASK_SUBMIT_POLICY,
  SUBMIT_POLICY,
  SUBMIT_RESULT_TOOL_DESCRIPTION,
  WRITEBACK_POLICY,
} from "../worker-policy.js";
import { resolveCursorSessionHint } from "../cursor-session-hint.js";

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

const fileIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^f_[A-Z0-9]+$/i, "fileId must look like f_…");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type ToolRegistrar = {
  tool: (
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    annotations: ToolAnnotations,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>
  ) => void;
};

function jsonContent(payload: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function artifactErrorContent(code: string, detail?: string): ToolResult {
  const text = detail ? `${code}: ${detail}` : code;
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

function handoffFileErrorResult(err: HandoffFileError): ToolResult {
  return artifactErrorContent(err.code, err.message);
}

function archiveErrorResult(err: ArchiveError): ToolResult {
  return artifactErrorContent(err.code, err.message);
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
      files: z
        .array(z.string().min(1).max(1_000))
        .max(100)
        .optional()
        .describe(
          "Workspace-relative evidence file paths (max 100). Attached as one tar.zst chip. No globs."
        ),
      workspaceRoot: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Absolute path to the host workspace for files[]. Required when MCP env HANDOFF_WORKSPACE_ROOT points at another repo; hook may inject."
        ),
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
      const hinted =
        !rawSession || rawSession === UNSCOPED_CLIENT_SESSION_ID
          ? resolveCursorSessionHint((args.prompt as string) ?? "")
          : null;
      const clientSessionId =
        rawSession && rawSession !== UNSCOPED_CLIENT_SESSION_ID
          ? rawSession
          : hinted || UNSCOPED_CLIENT_SESSION_ID;
      const scoped = clientSessionId !== UNSCOPED_CLIENT_SESSION_ID;

      const result = taskService.createTask({
        type: args.type as Parameters<TaskService["createTask"]>[0]["type"],
        prompt: args.prompt as string,
        context: args.context as Parameters<TaskService["createTask"]>[0]["context"],
        files: args.files as string[] | undefined,
        workspaceRoot: args.workspaceRoot as string | undefined,
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

      const files = (task.files ?? []).map((f) => ({
        fileId: f.fileId,
        displayName: f.displayName,
        relativePath: f.relativePath,
      }));

      const rawContext = (task.context ?? {}) as Record<string, unknown>;
      const {
        _probeToken: _ignored,
        _attachSecretRedaction: _attachIgnored,
        submitTemplate: _submitTemplate,
        ...publicContext
      } = rawContext;

      return jsonContent({
        taskId: task.id,
        type: task.type,
        prompt: task.prompt,
        context: publicContext,
        status: task.status,
        files,
        mustReadAttachedFiles:
          files.length > 0
            ? "Files are attached natively in ChatGPT — read attachment chips in the composer; do NOT call handoff_read_file (disabled in v0.7)."
            : undefined,
        submitTemplate:
          task.context?.submitTemplate &&
          typeof task.context.submitTemplate === "object"
            ? {
                ...task.context.submitTemplate,
                taskId: task.id,
              }
            : undefined,
        submitPolicy:
          task.taskClass === "SYSTEM_PROBE"
            ? PROBE_GET_TASK_SUBMIT_POLICY
            : {
                ...SUBMIT_POLICY,
                writeback: WRITEBACK_POLICY,
                writebackRequired: task.context?.writebackRequired === true,
                artifactsRequiredWhenAttached: (() => {
                  const tmpl = task.context?.submitTemplate as
                    | { archive?: unknown; artifacts?: unknown }
                    | undefined;
                  if (tmpl && typeof tmpl === "object" && tmpl.archive) {
                    return (
                      "submitTemplate.archive is required — pass it verbatim to " +
                      "handoff_submit_result. Do not invent artifacts[]."
                    );
                  }
                  if ((task.files?.length ?? 0) > 0) {
                    return (
                      "Task has attached workspace files. To modify them, include artifacts[] " +
                      "with complete file bodies in handoff_submit_result — result prose alone " +
                      "does not write disk. For larger batches use archive instead (XOR)."
                    );
                  }
                  return undefined;
                })(),
                lateSubmitAccepted:
                  task.status === "TIMED_OUT" && !task.result,
              },
      });
    }
  );

  server.tool(
    "handoff_read_file",
    "v0.7: disabled for tasks with native file attachments — evidence is delivered via ChatGPT composer chips only. "
      + "Returns FILE_READ_DISABLED when the task has attached files.",
    {
      taskId: taskIdSchema,
      fileId: fileIdSchema,
      offset: z.number().int().min(0).optional(),
      maxBytes: z.number().int().min(1).max(262_144).optional(),
    },
    {
      title: "Read handoff task file",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async (args) => {
      try {
        const output = taskService.readFile(
          args.taskId as string,
          args.fileId as string,
          args.offset as number | undefined,
          args.maxBytes as number | undefined
        );
        return jsonContent(output);
      } catch (err) {
        if (err instanceof HandoffFileError) {
          throw new Error(err.code);
        }
        throw new Error("FILE_NOT_ALLOWED");
      }
    }
  );

  server.tool(
    "handoff_ack",
    PROBE_ACK_TOOL_DESCRIPTION,
    {
      taskId: taskIdSchema,
    },
    {
      title: "Acknowledge system probe",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (args) => {
      const output = taskService.completeProbeAck(args.taskId as string);
      return jsonContent(output);
    }
  );

  server.tool(
    "handoff_complete_probe",
    PROBE_COMPLETE_TOOL_DESCRIPTION,
    {
      taskId: taskIdSchema,
      canary: z.string().min(1).max(128),
    },
    {
      title: "Complete worker probe",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (args) => {
      const output = taskService.completeProbe({
        taskId: args.taskId as string,
        canary: args.canary as string,
      });
      return jsonContent(output);
    }
  );

  server.tool(
    "handoff_submit_result",
    SUBMIT_RESULT_TOOL_DESCRIPTION,
    {
      taskId: taskIdSchema,
      result: z.string().min(1).max(MAX_RESULT),
      artifacts: z
        .array(
          z.object({
            path: z
              .string()
              .min(1)
              .max(1000)
              .describe("Workspace-relative POSIX path, e.g. src/foo.ts"),
            content: z
              .string()
              .max(MAX_BYTES_PER_FILE)
              .describe("Complete final UTF-8 file body (not a diff)"),
            mode: z
              .enum(["create", "overwrite"])
              .optional()
              .describe("overwrite for existing/attached files; create for new paths"),
          })
        )
        .max(MAX_ARTIFACTS_PER_SUBMIT)
        .optional()
        .describe(
          "Workspace file writes (max 20). Prefer for small batches. Mutually exclusive with archive."
        ),
      archive: z
        .object({
          format: z.literal("tar.zst"),
          encoding: z.literal("base64"),
          data: z
            .string()
            .min(1)
            .describe("Canonical base64 of a single-frame tar.zst archive"),
        })
        .optional()
        .describe(
          "Batch writeback as tar.zst (max 100 members). Mutually exclusive with artifacts[]."
        ),
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
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (args) => {
      try {
        const artifacts =
          (args.artifacts as Parameters<
            TaskService["submitResult"]
          >[0]["artifacts"]) ?? [];
        const archive = args.archive as
          | { format: "tar.zst"; encoding: "base64"; data: string }
          | undefined;
        if (archive && artifacts.length > 0) {
          return archiveErrorResult(
            new ArchiveError(
              "ARCHIVE_WITH_ARTIFACTS",
              "Pass archive XOR artifacts[] — not both"
            )
          );
        }
        const output = taskService.submitResult({
          taskId: args.taskId as string,
          result: args.result as string,
          metadata: args.metadata as Parameters<
            TaskService["submitResult"]
          >[0]["metadata"],
          artifacts,
          archive,
        });

        return jsonContent(output);
      } catch (err) {
        if (err instanceof ArchiveError) {
          return archiveErrorResult(err);
        }
        if (err instanceof HandoffFileError) {
          return handoffFileErrorResult(err);
        }
        throw new Error("ARTIFACT_WRITE_FAILED");
      }
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
