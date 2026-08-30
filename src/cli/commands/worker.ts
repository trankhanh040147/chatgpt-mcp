import type { ParsedArgs } from "../args.js";
import { hasFlag, wantsHelp, wantsJson } from "../args.js";
import {
  brokerOpsPort,
  loadCliConfig,
  statusBaseUrl,
  workersFilePath,
} from "../context.js";
import { collectSystemSnapshot } from "../ops/health.js";
import { setWorkerRegistryEnabled } from "../../config/write-workers-topology.js";
import { runCreateWorker } from "../../ops/create-worker.js";
import { runRotateWorker } from "../../ops/rotate-worker-cli.js";
import { WORKER_COMMANDS } from "../metadata.js";
import { ExitCode } from "../exit-codes.js";
import { blank, heading, style, writeJson } from "../terminal.js";

export async function runWorker(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  if (!sub || wantsHelp(args)) {
    heading("gptmcp worker");
    blank();
    for (const c of WORKER_COMMANDS) {
      console.log(`  ${style(c.name.padEnd(10), "cyan")} ${c.summary}`);
    }
    blank();
    return ExitCode.OK;
  }

  const config = loadCliConfig();
  const workersFile = workersFilePath(config);

  if (sub === "list") {
    const snap = await collectSystemSnapshot(config, brokerOpsPort());
    if (wantsJson(args)) {
      writeJson({ schemaVersion: 1, workers: snap.workers });
      return ExitCode.OK;
    }
    heading("Workers");
    blank();
    for (const w of snap.workers) {
      const state =
        w.enabled === false ? "DISABLED" : (w.healthState ?? w.status);
      console.log(`  ${w.id.padEnd(6)} ${state.padEnd(12)} ${w.detail ?? ""}`);
    }
    return ExitCode.OK;
  }

  if (sub === "inspect") {
    const id = args.positional[2];
    if (!id) {
      console.error("Usage: gptmcp worker inspect <id>");
      return ExitCode.USAGE;
    }
    const base = statusBaseUrl(config);
    try {
      const res = await fetch(`${base}/workers/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json()) as {
        workers?: Array<Record<string, unknown>>;
      };
      const row = body.workers?.find((w) => w.id === id);
      if (!row) {
        console.error(`Worker not found: ${id}`);
        return ExitCode.FAIL;
      }
      if (wantsJson(args)) {
        writeJson({ schemaVersion: 1, worker: row });
        return ExitCode.OK;
      }
      heading(`Worker ${id}`);
      blank();
      for (const [k, v] of Object.entries(row)) {
        if (k === "conditions" && Array.isArray(v)) {
          console.log("  conditions:");
          for (const c of v) {
            const cond = c as {
              type?: string;
              status?: string;
              reason?: string;
            };
            console.log(
              `    ${cond.type ?? "?"}  ${cond.status ?? "?"}  ${cond.reason ?? ""}`
            );
          }
        } else if (typeof v !== "object") {
          console.log(`  ${k}: ${String(v)}`);
        }
      }
      return ExitCode.OK;
    } catch {
      console.error("Status API not reachable — run: gptmcp start");
      return ExitCode.FAIL;
    }
  }

  if (sub === "add") {
    const result = await runCreateWorker({
      workersFile,
      yes: hasFlag(args, "yes"),
    });
    return result.ok ? ExitCode.OK : ExitCode.FAIL;
  }

  if (sub === "rotate") {
    const id = args.positional[2];
    if (!id) {
      console.error("Usage: gptmcp worker rotate <id>");
      return ExitCode.USAGE;
    }
    const result = await runRotateWorker({
      workerId: id,
      workersFile,
      yes: hasFlag(args, "yes"),
    });
    return result.ok ? ExitCode.OK : ExitCode.FAIL;
  }

  if (sub === "enable" || sub === "disable") {
    const id = args.positional[2];
    if (!id) {
      console.error(`Usage: gptmcp worker ${sub} <id>`);
      return ExitCode.USAGE;
    }
    setWorkerRegistryEnabled({
      filePath: workersFile,
      workerId: id,
      enabled: sub === "enable",
    });
    console.log(
      `Worker ${id} ${sub === "enable" ? "enabled" : "disabled"} in ${workersFile}`
    );
    console.log("Next: gptmcp restart");
    return ExitCode.OK;
  }

  console.error(`Unknown worker command: ${sub}`);
  console.error("Run: gptmcp worker --help");
  return ExitCode.USAGE;
}
