import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../../config/load-config.js";
import { resolveWorkersFilePath } from "../../config/load-config.js";
import { loadWorkersTopology, workersTopologySource } from "../../config/workers-topology.js";
import { isAssignableWorkerUrl } from "../../browser/chat-url.js";
import { ExitCode } from "../exit-codes.js";
import { repoRoot } from "../context.js";
import { collectSystemSnapshot, filterRegistryWorkers, probeCdp } from "./health.js";
import { stopOwnedServices } from "./process-registry.js";
import { blank, errMark, heading, kv, okMark, style } from "../terminal.js";

function runScript(script: string, env: Record<string, string> = {}): number {
  const root = repoRoot();
  const path = join(root, script);
  if (!existsSync(path)) {
    console.error(`Missing script: ${path}`);
    return ExitCode.FAIL;
  }
  chmodSync(path, 0o755);
  const res = spawnSync("bash", [path], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  return res.status ?? ExitCode.FAIL;
}

/** Runtime check only — never runs `npm run build`. */
export function requireDistArtifact(): boolean {
  const dist = join(repoRoot(), "dist", "index.js");
  if (existsSync(dist)) return true;
  console.error("Installation is incomplete: dist/index.js is missing.");
  console.error("From a source checkout: npm run build");
  console.error("From an npm install:    npm reinstall chatgpt-mcp");
  return false;
}

export async function ensureChrome(config: AppConfig): Promise<boolean> {
  if (await probeCdp(config.cdpEndpoint)) {
    console.log(`  ${okMark()} Chrome CDP              ${config.cdpEndpoint}`);
    return true;
  }
  console.log(`  Starting Chrome CDP…`);
  const res = spawnSync("npm", ["run", "chrome-cdp"], {
    cwd: repoRoot(),
    stdio: "inherit",
  });
  if ((res.status ?? 1) !== 0) return false;
  for (let i = 0; i < 30; i++) {
    if (await probeCdp(config.cdpEndpoint)) {
      console.log(`  ${okMark()} Chrome CDP              ${config.cdpEndpoint}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`  ${errMark()} Chrome CDP not ready`);
  return false;
}

async function waitReady(config: AppConfig, timeoutSec = 120): Promise<boolean> {
  const url = `http://127.0.0.1:${config.httpPort}`;
  const start = Date.now();
  const deadline = start + timeoutSec * 1000;
  let lastLog = 0;
  while (Date.now() < deadline) {
    try {
      const brokerRes = await fetch(`${url}/broker/status`, {
        signal: AbortSignal.timeout(2000),
      });
      const healthRes = await fetch(`${url}/workers/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!brokerRes.ok || !healthRes.ok) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const broker = (await brokerRes.json()) as {
        bindings?: unknown[];
        registryWorkerIds?: string[];
      };
      const body = (await healthRes.json()) as {
        workers?: Array<{ id: string; healthState?: string }>;
      };
      const registryIds = broker.registryWorkerIds ?? [];
      const bindings = broker.bindings?.length ?? 0;
      const registryWorkers = body.workers?.filter((w) =>
        registryIds.includes(w.id)
      );
      const anyReady = registryWorkers?.some((w) => w.healthState === "READY");
      const elapsed = Date.now() - start;
      if (bindings > 0 && anyReady) return true;
      // Tab bound — finish start even if worker awaits MCP consent / probe (BLOCKED/DEGRADED).
      if (bindings > 0 && elapsed >= 12_000) return true;

      if (elapsed - lastLog >= 8000) {
        console.log(
          style(
            `  … waiting for worker READY (${Math.round(elapsed / 1000)}s, bindings=${bindings})`,
            "dim"
          )
        );
        lastLog = elapsed;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function registryHasAssignableUrl(workersFile: string, config: AppConfig): boolean {
  try {
    const topo = loadWorkersTopology({
      dbPath: config.dbPath,
      workersFile: workersFile,
      workerId: config.workerId,
      workerUrl: "",
      cdpEndpoint: config.cdpEndpoint,
    });
    return topo.workers.some((w) => isAssignableWorkerUrl(w.workerUrl));
  } catch {
    return false;
  }
}

export async function startStack(config: AppConfig): Promise<number> {
  heading("ChatGPT MCP");
  blank();

  if (!requireDistArtifact()) return ExitCode.FAIL;
  console.log(`  ${okMark()} Configuration`);

  // Own stop before start — never rely on shell pkill.
  await stopOwnedServices({
    logDir: config.logDir,
    repoRoot: repoRoot(),
    httpPort: config.httpPort,
    remoteMcpPort: config.remoteMcpPort,
    brokerOpsPort: Number(process.env.HANDOFF_BROKER_OPS_PORT ?? 18788),
  });

  if (!(await ensureChrome(config))) return ExitCode.FAIL;

  const workersFile = resolveWorkersFilePath(config.workersFile);

  const stackEnv: Record<string, string> = {
    GPTMCP_SKIP_PKILL: "1",
    HANDOFF_DB_PATH: config.dbPath,
  };
  if (process.env.HANDOFF_WORKERS_FILE?.trim()) {
    stackEnv.HANDOFF_WORKERS_FILE = resolveWorkersFilePath(
      process.env.HANDOFF_WORKERS_FILE
    );
  } else if (workersTopologySource() === "file") {
    stackEnv.HANDOFF_WORKERS_FILE = workersFile;
  }

  const code = runScript("scripts/start-broker-stack.sh", stackEnv);
  if (code !== 0) return code;

  blank();
  let ready = false;
  if (!registryHasAssignableUrl(workersFile, config)) {
    console.log(
      style(
        "  Skipping readiness wait — no assignable chat URL in worker registry (DB).",
        "yellow"
      )
    );
    console.log(style("  gptmcp open → New chat… or paste a real /c/… URL", "dim"));
  } else {
    console.log(style("Waiting for readiness…", "dim"));
    ready = await waitReady(config);
  }
  blank();

  const snap = await collectSystemSnapshot(
    config,
    Number(process.env.HANDOFF_BROKER_OPS_PORT ?? 18788)
  );
  printStartSummary(snap, ready);
  if (!ready || snap.overall === "down") return ExitCode.UNHEALTHY;
  if (snap.overall === "degraded") return ExitCode.UNHEALTHY;
  return ExitCode.OK;
}

function printStartSummary(
  snap: Awaited<ReturnType<typeof collectSystemSnapshot>>,
  ready: boolean
): void {
  const mark = (s: string) =>
    s === "healthy" ? okMark() : s === "degraded" ? "!" : errMark();

  kv("", `${mark(snap.statusApi)} Status API              :${snap.ports.http}`);
  kv("", `${mark(snap.remoteMcp)} Remote MCP              :${snap.ports.remoteMcp}`);
  kv("", `${mark(snap.broker)} Browser broker          :${snap.ports.brokerOps}`);
  for (const w of filterRegistryWorkers(snap.workers, snap.registryWorkerIds)) {
    const wOk = w.healthState === "READY";
    kv(
      "",
      `${wOk ? okMark() : errMark()} Worker ${w.id.padEnd(12)} ${w.healthState ?? w.status}`
    );
  }
  blank();
  console.log(`  Dashboard`);
  console.log(`  ${snap.dashboardUrl}`);
  blank();
  const registryWorkers = filterRegistryWorkers(
    snap.workers,
    snap.registryWorkerIds
  );
  const anyWorkerReady = registryWorkers.some((w) => w.healthState === "READY");
  if (ready && anyWorkerReady) {
    console.log(style("Ready.", "green"));
  } else if (ready) {
    console.log(style("Stack is up — workers need dashboard action.", "yellow"));
    if (snap.brokerBindings > 0) {
      console.log(
        style("  gptmcp open → approve MCP in ChatGPT, then Retry verify", "dim")
      );
    }
    console.log(style("  gptmcp status", "dim"));
  } else {
    console.log(style("Stack is up but workers are not READY.", "yellow"));
    if (snap.brokerBindings === 0) {
      console.log(
        style(
          "  Broker has no tab bindings — assign a chat URL or create a new chat.",
          "dim"
        )
      );
      console.log(style("  gptmcp open  → New chat… or Assign URL…", "dim"));
    }
    console.log(style("  gptmcp doctor", "dim"));
  }
}

export async function stopStack(config: AppConfig): Promise<number> {
  heading("Stopping ChatGPT MCP…");
  const result = await stopOwnedServices({
    logDir: config.logDir,
    repoRoot: repoRoot(),
    httpPort: config.httpPort,
    remoteMcpPort: config.remoteMcpPort,
    brokerOpsPort: Number(process.env.HANDOFF_BROKER_OPS_PORT ?? 18788),
  });
  for (const s of result.stopped) {
    console.log(`  ${okMark()} stopped ${s.name} (pid ${s.pid})`);
  }
  for (const s of result.skipped) {
    console.log(style(`  · skipped ${s.name}: ${s.reason}`, "dim"));
  }
  for (const s of result.failed) {
    console.error(`  ${errMark()} ${s.name} pid ${s.pid}: ${s.error}`);
  }
  console.log("Stopped owned services (Chrome CDP unchanged).");
  return result.failed.length ? ExitCode.FAIL : ExitCode.OK;
}

export async function restartStack(config: AppConfig): Promise<number> {
  await stopStack(config);
  blank();
  return startStack(config);
}
