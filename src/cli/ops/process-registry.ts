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

/**
 * Leaf processes before supervisors — killing supervise first orphans children
 * that keep listening on stack ports (status-api :8787, etc.).
 */
export const STACK_SERVICES: ServiceSpec[] = [
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
    name: "browser-worker",
    pidFile: "browser-worker.pid",
    cmdlineMustInclude: ["dist/index.js", "browser-worker"],
  },
  {
    name: "worker",
    pidFile: "worker.pid",
    cmdlineMustInclude: ["dist/index.js", "worker"],
  },
  {
    name: "status-api-supervise",
    pidFile: "status-api-supervise.pid",
    cmdlineMustInclude: ["supervise-status-api"],
  },
  {
    name: "browser-worker-supervise",
    pidFile: "browser-worker-supervise.pid",
    cmdlineMustInclude: ["supervise-browser-worker"],
  },
];

const STATUS_API_SPEC = STACK_SERVICES.find((s) => s.name === "status-api")!;
const REMOTE_MCP_SPEC = STACK_SERVICES.find((s) => s.name === "remote-mcp")!;
const BROWSER_BROKER_SPEC = STACK_SERVICES.find(
  (s) => s.name === "browser-broker"
)!;

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

function listenerPidOnPort(port: number): number | null {
  const res = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" }
  );
  if (res.status !== 0 || !res.stdout?.trim()) return null;
  const first = res.stdout.trim().split(/\s+/)[0];
  const pid = Number(first);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

async function terminatePid(
  pid: number,
  spec: ServiceSpec,
  graceMs: number,
  result: StopResult
): Promise<void> {
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
}

async function stopFromPidFile(
  spec: ServiceSpec,
  pidPath: string,
  graceMs: number,
  result: StopResult
): Promise<void> {
  const pid = readPid(pidPath);
  if (pid == null) {
    clearPidFile(pidPath);
    return;
  }
  const owned = ownsProcess(pid, spec);
  if (!owned.ok) {
    result.skipped.push({ name: spec.name, reason: owned.reason });
    if (owned.reason === "not running") {
      clearPidFile(pidPath);
    }
    return;
  }
  await terminatePid(pid, spec, graceMs, result);
  clearPidFile(pidPath);
}

/** Reclaim a stack port held by an owned listener not recorded in pid files. */
async function reclaimOwnedPortListener(
  port: number,
  spec: ServiceSpec,
  graceMs: number,
  result: StopResult
): Promise<void> {
  const pid = listenerPidOnPort(port);
  if (pid == null) return;
  const owned = ownsProcess(pid, spec);
  if (!owned.ok) return;
  const alreadyStopped = result.stopped.some((s) => s.pid === pid);
  if (alreadyStopped) return;
  await terminatePid(pid, spec, graceMs, result);
}

function findRepoSupervisorPids(
  repoRoot: string,
  scriptName: string
): number[] {
  const needle = join(repoRoot, "scripts", scriptName);
  const res = spawnSync("pgrep", ["-f", scriptName], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout?.trim()) return [];
  const pids: number[] = [];
  for (const line of res.stdout.trim().split(/\s+/)) {
    const pid = Number(line);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const cmd = processCmdline(pid);
    if (cmd?.includes(needle)) {
      pids.push(pid);
    }
  }
  return pids;
}

async function stopRepoSupervisors(
  repoRoot: string,
  graceMs: number,
  result: StopResult
): Promise<void> {
  const specs: Array<{ script: string; spec: ServiceSpec }> = [
    {
      script: "supervise-status-api.sh",
      spec: STACK_SERVICES.find((s) => s.name === "status-api-supervise")!,
    },
    {
      script: "supervise-browser-worker.sh",
      spec: STACK_SERVICES.find((s) => s.name === "browser-worker-supervise")!,
    },
  ];
  for (const { script, spec } of specs) {
    for (const pid of findRepoSupervisorPids(repoRoot, script)) {
      const owned = ownsProcess(pid, spec);
      if (!owned.ok) continue;
      const alreadyStopped = result.stopped.some((s) => s.pid === pid);
      if (alreadyStopped) continue;
      await terminatePid(pid, spec, graceMs, result);
    }
  }
}

/**
 * Stop only processes recorded in this instance's PID files whose cmdline
 * matches the expected ownership markers. Never uses blind `pkill -f`.
 */
export async function stopOwnedServices(opts: {
  logDir: string;
  repoRoot: string;
  graceMs?: number;
  httpPort?: number;
  remoteMcpPort?: number;
  brokerOpsPort?: number;
}): Promise<StopResult> {
  const graceMs = opts.graceMs ?? 3000;
  const result: StopResult = { stopped: [], skipped: [], failed: [] };
  mkdirSync(opts.logDir, { recursive: true });

  for (const spec of STACK_SERVICES) {
    const pidPath = join(opts.logDir, spec.pidFile);
    await stopFromPidFile(spec, pidPath, graceMs, result);
  }

  const httpPort = opts.httpPort ?? 8787;
  const remoteMcpPort = opts.remoteMcpPort ?? 8790;
  const brokerOpsPort = opts.brokerOpsPort ?? 18788;

  await reclaimOwnedPortListener(
    httpPort,
    STATUS_API_SPEC,
    graceMs,
    result
  );
  await reclaimOwnedPortListener(
    remoteMcpPort,
    REMOTE_MCP_SPEC,
    graceMs,
    result
  );
  await reclaimOwnedPortListener(
    brokerOpsPort,
    BROWSER_BROKER_SPEC,
    graceMs,
    result
  );

  await stopRepoSupervisors(opts.repoRoot, graceMs, result);

  // Supervisors may have respawned a child during the sweep above.
  await reclaimOwnedPortListener(httpPort, STATUS_API_SPEC, graceMs, result);
  await reclaimOwnedPortListener(
    remoteMcpPort,
    REMOTE_MCP_SPEC,
    graceMs,
    result
  );
  await reclaimOwnedPortListener(
    brokerOpsPort,
    BROWSER_BROKER_SPEC,
    graceMs,
    result
  );

  return result;
}

export function writePidFile(logDir: string, name: string, pid: number): void {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, `${name}.pid`), `${pid}\n`, "utf8");
}
