import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type ManagedService =
  | "remote-mcp"
  | "browser-broker"
  | "status-api-supervise"
  | "status-api"
  | "browser-worker-supervise"
  | "browser-worker"
  | "worker";

export interface ServiceSpec {
  name: ManagedService;
  pidFile: string;
  /** Substrings that must all appear in the process cmdline (ownership). */
  cmdlineMustInclude: string[];
}

/** Services gptmcp start/stop own for the A1-S broker stack. */
export const STACK_SERVICES: ServiceSpec[] = [
  {
    name: "status-api-supervise",
    pidFile: "status-api-supervise.pid",
    cmdlineMustInclude: ["supervise-status-api"],
  },
  {
    name: "status-api",
    pidFile: "status-api.pid",
    cmdlineMustInclude: ["dist/index.js", "status-api"],
  },
  {
    name: "remote-mcp",
    pidFile: "remote-mcp.pid",
    cmdlineMustInclude: ["dist/index.js", "remote-mcp"],
  },
  {
    name: "browser-broker",
    pidFile: "browser-broker.pid",
    cmdlineMustInclude: ["dist/index.js", "browser-broker"],
  },
  {
    name: "browser-worker-supervise",
    pidFile: "browser-worker-supervise.pid",
    cmdlineMustInclude: ["supervise-browser-worker"],
  },
  {
    name: "browser-worker",
    pidFile: "browser-worker.pid",
    cmdlineMustInclude: ["dist/index.js", "browser-worker"],
  },
  {
    name: "worker",
    pidFile: "worker.pid",
    cmdlineMustInclude: ["dist/index.js", "worker"],
  },
];

export interface StopResult {
  stopped: Array<{ name: ManagedService; pid: number }>;
  skipped: Array<{ name: ManagedService; reason: string }>;
  failed: Array<{ name: ManagedService; pid: number; error: string }>;
}

function readPid(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    return code === "EPERM";
  }
}

/** Process cmdline via `ps` (portable enough for macOS + Linux desktop). */
export function processCmdline(pid: number): string | null {
  try {
    const res = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    if (res.status !== 0) return null;
    return (res.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

function ownsProcess(
  pid: number,
  spec: ServiceSpec
): { ok: true } | { ok: false; reason: string } {
  if (!isPidAlive(pid)) {
    return { ok: false, reason: "not running" };
  }
  const cmd = processCmdline(pid);
  if (!cmd) {
    return { ok: false, reason: "cannot read cmdline" };
  }
  for (const needle of spec.cmdlineMustInclude) {
    if (!cmd.includes(needle)) {
      return {
        ok: false,
        reason: `cmdline does not match owned pattern (want …${needle}…)`,
      };
    }
  }
  return { ok: true };
}

function clearPidFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stop only processes recorded in this instance's PID files whose cmdline
 * matches the expected ownership markers. Never uses `pkill -f`.
 */
export async function stopOwnedServices(opts: {
  logDir: string;
  repoRoot: string;
  graceMs?: number;
}): Promise<StopResult> {
  const graceMs = opts.graceMs ?? 3000;
  const result: StopResult = { stopped: [], skipped: [], failed: [] };
  mkdirSync(opts.logDir, { recursive: true });

  for (const spec of STACK_SERVICES) {
    const pidPath = join(opts.logDir, spec.pidFile);
    const pid = readPid(pidPath);
    if (pid == null) {
      clearPidFile(pidPath);
      continue;
    }
    const owned = ownsProcess(pid, spec);
    if (!owned.ok) {
      result.skipped.push({ name: spec.name, reason: owned.reason });
      // Only clear stale pid files when the process is gone.
      if (owned.reason === "not running") {
        clearPidFile(pidPath);
      }
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline && isPidAlive(pid)) {
        await sleep(100);
      }
      if (isPidAlive(pid)) {
        process.kill(pid, "SIGKILL");
        await sleep(200);
      }
      if (isPidAlive(pid)) {
        result.failed.push({
          name: spec.name,
          pid,
          error: "still alive after SIGKILL",
        });
      } else {
        result.stopped.push({ name: spec.name, pid });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ name: spec.name, pid, error: message });
    }
    clearPidFile(pidPath);
  }

  return result;
}

export function writePidFile(logDir: string, name: string, pid: number): void {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, `${name}.pid`), `${pid}\n`, "utf8");
}
