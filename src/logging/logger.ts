import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogComponent =
  | "mcp-server"
  | "task-service"
  | "browser-worker"
  | "browser-broker"
  | "create-worker"
  | "http-api"
  | "cursor-hook"
  | "lease-reaper"
  | "config";

export type LogEvent =
  | "TASK_CREATED"
  | "TASK_DISPATCHED"
  | "CHATGPT_PROCESSING"
  | "RESULT_RECEIVED"
  | "CURSOR_RESUMED"
  | "CURSOR_WAIT_TIMEOUT"
  | "WORKER_SESSION_LOST"
  | "WORKER_NEEDS_APPROVAL"
  | "RATE_LIMITED"
  | "TASK_FAILED"
  | "TASK_TIMED_OUT"
  | "STATE_TRANSITION"
  | "INFO"
  | "WARN"
  | "ERROR";

export interface LogEntry {
  timestamp: string;
  event: LogEvent;
  component: LogComponent;
  taskId?: string;
  from?: string;
  to?: string;
  message?: string;
  data?: Record<string, unknown>;
}

let logDir = "./logs";

export function configureLogger(dir: string): void {
  logDir = dir;
  mkdirSync(logDir, { recursive: true });
}

export function log(entry: Omit<LogEntry, "timestamp">): void {
  mkdirSync(logDir, { recursive: true });
  const line: LogEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  const file = join(logDir, "handoff.log");
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  if (process.env.HANDOFF_LOG_STDERR === "1") {
    console.error(JSON.stringify(line));
  }
}

export function logTransition(
  component: LogComponent,
  taskId: string,
  from: string,
  to: string
): void {
  log({
    event: "STATE_TRANSITION",
    component,
    taskId,
    from,
    to,
  });
}
