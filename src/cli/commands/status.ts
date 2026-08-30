import type { ParsedArgs } from "../args.js";
import { wantsJson } from "../args.js";
import { ExitCode } from "../exit-codes.js";
import {
  brokerOpsPort,
  dashboardUrl,
  loadCliConfig,
} from "../context.js";
import {
  collectSystemSnapshot,
  serviceLabel,
  type SystemSnapshot,
} from "../ops/health.js";
import {
  blank,
  heading,
  kv,
  statusDot,
  style,
  writeJson,
} from "../terminal.js";

export async function runStatus(args: ParsedArgs): Promise<number> {
  const config = loadCliConfig();
  const snap = await collectSystemSnapshot(config, brokerOpsPort());

  if (wantsJson(args)) {
    writeJson(toJson(snap));
    return healthExit(snap);
  }

  heading("ChatGPT MCP");
  blank();
  console.log("SYSTEM");
  printService("Status API", snap.statusApi, `:${snap.ports.http}`);
  printService("Remote MCP", snap.remoteMcp, `:${snap.ports.remoteMcp}`);
  printService("Browser broker", snap.broker, `:${snap.ports.brokerOps}`);
  printService("Chrome CDP", snap.chromeCdp, snap.ports.cdp);
  blank();

  if (snap.workers.length) {
    console.log("WORKERS");
    for (const w of snap.workers) {
      const dot =
        w.healthState === "READY" || w.status === "READY"
          ? statusDot(true)
          : w.enabled === false
            ? statusDot("warn")
            : statusDot(false);
      const label =
        w.enabled === false ? "DISABLED" : (w.healthState ?? w.status);
      console.log(
        `  ${w.id.padEnd(6)} ${dot}  ${label.padEnd(12)} ${w.detail ?? ""}`
      );
    }
    blank();
  }

  console.log("QUEUE");
  kv("queued", String(snap.queue.queued), 14);
  kv("dispatching", String(snap.queue.dispatching), 14);
  kv("failed", String(snap.queue.failed), 14);
  blank();

  const overallColor =
    snap.overall === "healthy"
      ? "green"
      : snap.overall === "down"
        ? "red"
        : "yellow";
  console.log(
    `Overall`.padEnd(16) +
      style(serviceLabel(snap.overall).toUpperCase(), overallColor)
  );
  blank();
  console.log(style(`Dashboard  ${dashboardUrl(config)}`, "dim"));

  if (snap.overall !== "healthy") {
    blank();
    console.log("Next");
    console.log("  gptmcp doctor");
  }

  return healthExit(snap);
}

function healthExit(snap: SystemSnapshot): number {
  if (snap.overall === "healthy") return ExitCode.OK;
  return ExitCode.UNHEALTHY;
}

function printService(
  name: string,
  state: SystemSnapshot["statusApi"],
  suffix: string
): void {
  const dot =
    state === "healthy"
      ? statusDot(true)
      : state === "degraded"
        ? statusDot("warn")
        : statusDot(false);
  console.log(
    `  ${dot} ${name.padEnd(18)} ${serviceLabel(state)}  ${suffix}`
  );
}

function toJson(snap: SystemSnapshot): Record<string, unknown> {
  return {
    schemaVersion: 1,
    status: snap.overall,
    running: snap.running,
    services: {
      statusApi: snap.statusApi,
      remoteMcp: snap.remoteMcp,
      broker: snap.broker,
      chromeCdp: snap.chromeCdp,
    },
    workers: snap.workers.map((w) => ({
      id: w.id,
      status: w.status,
      healthState: w.healthState ?? null,
      enabled: w.enabled !== false,
      recommendedAction: w.recommendedAction ?? null,
    })),
    queue: snap.queue,
    ports: snap.ports,
    dashboardUrl: snap.dashboardUrl,
  };
}
