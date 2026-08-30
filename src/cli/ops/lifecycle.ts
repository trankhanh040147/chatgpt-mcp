import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../../config/load-config.js";
import { resolveWorkersFilePath } from "../../config/load-config.js";
import { ExitCode } from "../exit-codes.js";
import { repoRoot } from "../context.js";
import { collectSystemSnapshot, probeCdp } from "./health.js";
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
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/workers/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          workers?: Array<{ healthState?: string; status?: string }>;
        };
        const ready = body.workers?.some(
          (w) => w.healthState === "READY" || w.status === "READY"
        );
        if (ready) return true;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export async function startStack(config: AppConfig): Promise<number> {
  heading("ChatGPT MCP");
  blank();

  if (!requireDistArtifact()) return ExitCode.FAIL;
  console.log(`  ${okMark()} Configuration`);

  // Own stop before start — never rely on shell pkill.
  await stopOwnedServices({ logDir: config.logDir, repoRoot: repoRoot() });

  if (!(await ensureChrome(config))) return ExitCode.FAIL;

  const workersFile = resolveWorkersFilePath(config.workersFile);

  const code = runScript("scripts/start-broker-stack.sh", {
    HANDOFF_WORKERS_FILE: workersFile,
    GPTMCP_SKIP_PKILL: "1",
  });
  if (code !== 0) return code;

  blank();
  console.log(style("Waiting for readiness…", "dim"));
  const ready = await waitReady(config);
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
  for (const w of snap.workers) {
    const wOk = w.healthState === "READY" || w.status === "READY";
    kv(
      "",
      `${wOk ? okMark() : errMark()} Worker ${w.id.padEnd(12)} ${w.healthState ?? w.status}`
    );
  }
  blank();
  console.log(`  Dashboard`);
  console.log(`  ${snap.dashboardUrl}`);
  blank();
  if (ready) {
    console.log(style("Ready.", "green"));
  } else {
    console.log(style("Started with warnings — run: gptmcp doctor", "yellow"));
  }
}

export async function stopStack(config: AppConfig): Promise<number> {
  heading("Stopping ChatGPT MCP…");
  const result = await stopOwnedServices({
    logDir: config.logDir,
    repoRoot: repoRoot(),
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
