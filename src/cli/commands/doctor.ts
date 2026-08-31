import { existsSync } from "node:fs";
import { join } from "node:path";
import { initDatabase, getDatabase, SCHEMA_USER_VERSION } from "../../db/sqlite.js";
import {
  loadWorkersTopology,
  validateWorkersTopology,
} from "../../config/workers-topology.js";
import { isAssignableWorkerUrl } from "../../browser/chat-url.js";
import {
  topologyAllowsSharedCdp,
} from "../../config/write-workers-topology.js";
import { isProbeMcpFailureReason } from "../../mcp/probe-failure.js";
import { detectDbPathSplitBrain } from "../../config/load-config.js";
import type { ParsedArgs } from "../args.js";
import { hasFlag, wantsJson } from "../args.js";
import { ExitCode } from "../exit-codes.js";
import {
  brokerOpsPort,
  loadCliConfig,
  repoRoot,
  workersFilePath,
} from "../context.js";
import {
  collectSystemSnapshot,
  filterRegistryWorkers,
  probeCdp,
  probeRemoteMcp,
} from "../ops/health.js";
import {
  blank,
  errMark,
  heading,
  okMark,
  style,
  writeJson,
} from "../terminal.js";

export async function runDoctor(args: ParsedArgs): Promise<number> {
  const config = loadCliConfig();
  const verbose = hasFlag(args, "verbose") || hasFlag(args, "v");
  const issues: string[] = [];
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const nodeOk =
    Number(process.versions.node.split(".")[0]) > 22 ||
    (Number(process.versions.node.split(".")[0]) === 22 &&
      Number(process.versions.node.split(".")[1] ?? 0) >= 14);
  checks.push({
    name: "Node.js",
    ok: nodeOk,
    detail: `v${process.versions.node}`,
  });
  if (!nodeOk) issues.push("Node.js >= 22.14 required");

  const distOk = existsSync(join(repoRoot(), "dist", "index.js"));
  checks.push({
    name: "Build",
    ok: distOk,
    detail: distOk ? "dist/" : "run: npm run build",
  });
  if (!distOk) issues.push("Project not built");

  const dbSplit = detectDbPathSplitBrain(config.dbPath, repoRoot());
  if (dbSplit) {
    checks.push({ name: "DB path", ok: false, detail: "split-brain risk" });
    issues.push(dbSplit);
  } else {
    checks.push({
      name: "DB path",
      ok: true,
      detail: config.dbPath,
    });
  }

  try {
    const topology = loadWorkersTopology({
      dbPath: config.dbPath,
      workersFile: workersFilePath(config),
      workerId: config.workerId,
      workerUrl: "",
      cdpEndpoint: config.cdpEndpoint,
    });
    validateWorkersTopology(topology, {
      allowSharedCdp: topologyAllowsSharedCdp(topology),
    });
    checks.push({
      name: "Configuration",
      ok: true,
      detail: `${topology.workers.length} worker(s) in registry`,
    });
    const pending = topology.workers.filter(
      (w) => !isAssignableWorkerUrl(w.workerUrl)
    );
    if (pending.length > 0) {
      issues.push(
        `Worker URL not assigned (${pending.map((w) => w.id).join(", ")}) — gptmcp open → New chat…`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "Configuration", ok: false, detail: msg });
    issues.push(msg);
  }

  try {
    initDatabase(config.dbPath);
    const ver = getDatabase().prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    const schemaOk = Number(ver.user_version) === SCHEMA_USER_VERSION;
    checks.push({
      name: "SQLite schema",
      ok: schemaOk,
      detail: `v${ver.user_version}`,
    });
    if (!schemaOk) issues.push("Schema version mismatch");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "SQLite schema", ok: false, detail: msg });
    issues.push(msg);
  }

  const cdpOk = await probeCdp(config.cdpEndpoint);
  checks.push({
    name: "Chrome CDP",
    ok: cdpOk,
    detail: config.cdpEndpoint,
  });
  if (!cdpOk) issues.push("Chrome CDP not connected — gptmcp start");

  const remoteOk = await probeRemoteMcp(config);
  checks.push({
    name: "Remote MCP",
    ok: remoteOk,
    detail: `:${config.remoteMcpPort}`,
  });
  if (!remoteOk) issues.push("Remote MCP down");

  const snap = await collectSystemSnapshot(config, brokerOpsPort());
  checks.push({
    name: "Status API",
    ok: snap.statusApi === "healthy",
    detail: `:${snap.ports.http}`,
  });
  checks.push({
    name: "Broker",
    ok: snap.broker === "healthy",
    detail: `:${snap.ports.brokerOps} · bindings=${snap.brokerBindings}`,
  });
  if (snap.brokerBindings === 0 && snap.registryWorkerIds.length > 0) {
    issues.push(
      "Broker has no tab bindings — open dashboard → New chat… or Assign URL…"
    );
  }

  const registryWorkers = filterRegistryWorkers(
    snap.workers,
    snap.registryWorkerIds
  );
  for (const w of registryWorkers) {
    const ok = w.healthState === "READY";
    checks.push({
      name: `Worker ${w.id}`,
      ok,
      detail: w.readinessReason && isProbeMcpFailureReason(w.readinessReason)
        ? w.readinessReason
        : (w.healthState ?? w.status),
    });
    if (!ok && w.readinessReason) {
      issues.push(`Worker ${w.id}: ${w.readinessReason}`);
    } else if (!ok) {
      issues.push(`Worker ${w.id}: ${w.healthState ?? w.status}`);
    }
  }

  if (wantsJson(args)) {
    writeJson({
      schemaVersion: 1,
      ok: issues.length === 0,
      checks,
      suggestedAction: issues.length ? "gptmcp recover" : null,
    });
    return issues.length ? ExitCode.UNHEALTHY : ExitCode.OK;
  }

  heading("Running diagnostics…");
  blank();
  for (const c of checks) {
    console.log(`  ${c.ok ? okMark() : errMark()} ${c.name.padEnd(18)} ${c.detail}`);
  }

  if (issues.length === 0) {
    blank();
    console.log(style("All checks passed.", "green"));
    return ExitCode.OK;
  }

  blank();
  console.log(style("Problem", "bold"));
  blank();
  console.log(`  ${issues[0]}`);
  blank();
  console.log(style("Suggested action", "bold"));
  blank();
  console.log("  gptmcp recover");
  if (snap.broker === "down") console.log("  gptmcp restart");
  blank();
  if (verbose) {
    console.log(style("Details", "bold"));
    for (const issue of issues.slice(1)) console.log(`  • ${issue}`);
    blank();
  }
  return ExitCode.UNHEALTHY;
}
