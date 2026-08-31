export type OptionType = "boolean" | "string";

export interface OptionMeta {
  type: OptionType;
  short?: string;
  description?: string;
}

export interface CommandMeta {
  name: string;
  summary: string;
  category: "Lifecycle" | "Observe" | "Repair" | "Workers" | "Help";
  examples?: string[];
  hidden?: boolean;
  /** Max positional args after the command name (not counting subcommands). */
  maxPositionals?: number;
  options?: Record<string, OptionMeta>;
  subcommands?: CommandMeta[];
}

/** Global flags accepted on every command. */
export const GLOBAL_OPTIONS: Record<string, OptionMeta> = {
  help: { type: "boolean", short: "h", description: "Show help" },
  "no-color": { type: "boolean", description: "Disable ANSI color" },
};

export const WORKER_COMMANDS: CommandMeta[] = [
  {
    name: "list",
    summary: "List workers and health",
    category: "Workers",
    examples: ["gptmcp worker list"],
    maxPositionals: 0,
    options: {
      json: { type: "boolean", description: "Machine-readable JSON" },
    },
  },
  {
    name: "add",
    summary: "Assisted new worker chat (interactive)",
    category: "Workers",
    examples: ["gptmcp worker add"],
    maxPositionals: 0,
    options: {
      yes: { type: "boolean", short: "y", description: "Skip interactive pauses" },
    },
  },
  {
    name: "inspect",
    summary: "Detailed worker diagnostics",
    category: "Workers",
    examples: ["gptmcp worker inspect w1"],
    maxPositionals: 1,
    options: {
      json: { type: "boolean", description: "Machine-readable JSON" },
    },
  },
  {
    name: "rotate",
    summary: "Rotate worker chat (idle-only)",
    category: "Workers",
    examples: ["gptmcp worker rotate w1"],
    maxPositionals: 1,
    options: {
      yes: { type: "boolean", short: "y", description: "Skip interactive pauses" },
    },
  },
  {
    name: "enable",
    summary: "Enable worker in registry",
    category: "Workers",
    examples: ["gptmcp worker enable w1"],
    maxPositionals: 1,
    options: {},
  },
  {
    name: "disable",
    summary: "Disable worker in registry",
    category: "Workers",
    examples: ["gptmcp worker disable w1"],
    maxPositionals: 1,
    options: {},
  },
];

export const TOP_COMMANDS: CommandMeta[] = [
  {
    name: "setup",
    summary: "Bootstrap user config and print MCP JSON",
    category: "Lifecycle",
    examples: ["gptmcp setup", "gptmcp setup --home ~/.chatgpt-mcp"],
    maxPositionals: 0,
    options: {
      home: { type: "string", description: "Override CHATGPT_MCP_HOME" },
      json: { type: "boolean", description: "Machine-readable SetupReport" },
    },
  },
  {
    name: "completion",
    summary: "Generate shell completion (fish/bash)",
    category: "Help",
    examples: ["gptmcp completion fish", "gptmcp completion bash"],
    maxPositionals: 1,
    options: {},
  },
  {
    name: "start",
    summary: "Start ChatGPT MCP stack",
    category: "Lifecycle",
    examples: ["gptmcp start"],
    maxPositionals: 0,
    options: {},
  },
  {
    name: "stop",
    summary: "Stop services (Chrome CDP stays up)",
    category: "Lifecycle",
    examples: ["gptmcp stop"],
    maxPositionals: 0,
    options: {},
  },
  {
    name: "restart",
    summary: "Restart the broker stack",
    category: "Lifecycle",
    examples: ["gptmcp restart"],
    maxPositionals: 0,
    options: {},
  },
  {
    name: "status",
    summary: "Show system health",
    category: "Observe",
    examples: ["gptmcp status", "gptmcp status --json"],
    maxPositionals: 0,
    options: {
      json: { type: "boolean", description: "Machine-readable JSON" },
    },
  },
  {
    name: "logs",
    summary: "View structured activity logs",
    category: "Observe",
    examples: [
      "gptmcp logs",
      "gptmcp logs --follow",
      "gptmcp logs --errors --since 10m",
    ],
    maxPositionals: 0,
    options: {
      follow: { type: "boolean", short: "f", description: "Follow log output" },
      since: { type: "string", description: "Only entries newer than duration (e.g. 10m)" },
      worker: { type: "string", description: "Filter by worker id" },
      task: { type: "string", description: "Filter by task id" },
      errors: { type: "boolean", description: "Only errors and warnings" },
      json: { type: "boolean", description: "Emit JSONL" },
    },
  },
  {
    name: "doctor",
    summary: "Deep diagnostics with suggested next steps",
    category: "Repair",
    examples: ["gptmcp doctor", "gptmcp doctor --verbose"],
    maxPositionals: 0,
    options: {
      verbose: { type: "boolean", short: "v", description: "Show extra details" },
      json: { type: "boolean", description: "Machine-readable JSON" },
    },
  },
  {
    name: "recover",
    summary: "Repair common queue/worker problems",
    category: "Repair",
    examples: [
      "gptmcp recover",
      "gptmcp recover --yes",
      "gptmcp recover --all --yes",
    ],
    maxPositionals: 0,
    options: {
      yes: { type: "boolean", short: "y", description: "Skip confirmation" },
      all: { type: "boolean", description: "Fail open + queued + reset all workers" },
      "reset-queue": { type: "boolean", description: "Also fail QUEUED tasks" },
      task: { type: "string", description: "Keep this task id when failing others" },
      keep: { type: "string", description: "Alias of --task" },
      json: { type: "boolean", description: "Print plan as JSON (no mutate)" },
    },
  },
  {
    name: "open",
    summary: "Open the ops dashboard in your browser",
    category: "Observe",
    examples: ["gptmcp open"],
    maxPositionals: 0,
    options: {},
  },
  {
    name: "worker",
    summary: "Manage workers (list, add, rotate, …)",
    category: "Workers",
    examples: [
      "gptmcp worker list",
      "gptmcp worker add",
      "gptmcp worker rotate w1",
    ],
    maxPositionals: 2,
    options: {
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
    },
    subcommands: WORKER_COMMANDS,
  },
  {
    name: "help",
    summary: "Show help (gptmcp help --web for cheatsheet)",
    category: "Help",
    examples: ["gptmcp help", "gptmcp help --web"],
    maxPositionals: 1,
    options: {
      web: { type: "boolean", description: "Open HTML cheatsheet" },
    },
  },
];

export function findTopCommand(name: string): CommandMeta | undefined {
  return TOP_COMMANDS.find((c) => c.name === name);
}

export function findWorkerCommand(name: string): CommandMeta | undefined {
  return WORKER_COMMANDS.find((c) => c.name === name);
}
