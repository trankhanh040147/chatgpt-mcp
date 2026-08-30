import type { ParsedArgs } from "./args.js";
import { parseArgs, UsageError, wantsHelp } from "./args.js";
import { ExitCode } from "./exit-codes.js";
import { runDoctor } from "./commands/doctor.js";
import { runHelp } from "./commands/help.js";
import { runLogs } from "./commands/logs.js";
import { runOpen } from "./commands/open.js";
import { runRecover } from "./commands/recover.js";
import { runRestart } from "./commands/restart.js";
import { runStart } from "./commands/start.js";
import { runStatus } from "./commands/status.js";
import { runStop } from "./commands/stop.js";
import { runWorker } from "./commands/worker.js";
import { runSetupCommand } from "./commands/setup.js";
import { runCompletion } from "./commands/completion.js";
import { brokerOpsPort, loadCliConfig } from "./context.js";
import { collectSystemSnapshot } from "./ops/health.js";
import {
  blank,
  heading,
  statusDot,
  style,
  VERSION,
} from "./terminal.js";

export async function runCli(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      return err.exitCode;
    }
    throw err;
  }

  const cmd = args.command;

  if (!cmd || wantsHelp(args)) {
    return runHelp(args);
  }

  switch (cmd) {
    case "setup":
      return runSetupCommand(args);
    case "completion":
      return runCompletion(args);
    case "start":
      return runStart(args);
    case "stop":
      return runStop(args);
    case "restart":
      return runRestart(args);
    case "status":
      return runStatus(args);
    case "logs":
      return runLogs(args);
    case "doctor":
      return runDoctor(args);
    case "recover":
      return runRecover(args);
    case "open":
      return runOpen(args);
    case "worker":
      return runWorker(args);
    case "help":
      return runHelp(args);
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Run: gptmcp help");
      return ExitCode.USAGE;
  }
}

/** Default UX when invoked with no arguments. */
export async function runDefaultBanner(): Promise<number> {
  const config = loadCliConfig();
  const snap = await collectSystemSnapshot(config, brokerOpsPort());

  heading(`ChatGPT MCP`.padEnd(28) + style(`v${VERSION}`, "dim"));
  blank();

  if (!snap.running) {
    console.log(`System: ${statusDot(false)} STOPPED`);
    blank();
    console.log("Start it with:");
    blank();
    console.log("  gptmcp start");
    blank();
    console.log(style("More: gptmcp help", "dim"));
    return ExitCode.OK;
  }

  const readyWorker = snap.workers.find((w) => w.healthState === "READY");
  const focus =
    readyWorker ??
    snap.workers.find((w) => w.enabled !== false && w.id !== "default") ??
    snap.workers[0];
  const systemDot =
    snap.overall === "healthy"
      ? statusDot(true)
      : snap.overall === "degraded"
        ? statusDot("warn")
        : statusDot(false);
  console.log(`System: ${systemDot} ${snap.overall.toUpperCase()}`);
  if (focus) {
    const ok = focus.healthState === "READY";
    console.log(
      `Worker: ${statusDot(ok ? true : focus.enabled === false ? "warn" : false)} ${focus.id} ${focus.healthState ?? focus.status}`
    );
  }
  console.log(`Queue:  ${snap.queue.open}`);
  blank();
  console.log("Common commands");
  blank();
  console.log("  gptmcp status      Show health");
  console.log("  gptmcp logs        Watch activity");
  console.log("  gptmcp open        Open dashboard");
  console.log("  gptmcp doctor      Diagnose problems");
  blank();
  console.log(style("Need help?  gptmcp help", "dim"));
  return ExitCode.OK;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    return runDefaultBanner();
  }
  return runCli(argv);
}
