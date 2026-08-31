import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { initDatabase } from "../../db/sqlite.js";
import { planRecover, executeRecover } from "../../ops/recover.js";
import type { ParsedArgs } from "../args.js";
import { hasFlag, option, wantsJson } from "../args.js";
import { ExitCode } from "../exit-codes.js";
import { loadCliConfig } from "../context.js";
import {
  blank,
  heading,
  okMark,
  style,
  warnMark,
  writeJson,
} from "../terminal.js";

export async function runRecover(args: ParsedArgs): Promise<number> {
  const config = loadCliConfig();
  const db = initDatabase(config.dbPath);

  const failQueued = hasFlag(args, "reset-queue") || hasFlag(args, "all");
  const failOpen = hasFlag(args, "all");
  const resetAllWorkers = hasFlag(args, "all");
  const yes = hasFlag(args, "yes");
  const keepId = option(args, "task") ?? option(args, "keep");

  const plan = planRecover(db, {
    failQueued,
    failOpen,
    keepId,
    resetAllWorkers,
  });

  if (wantsJson(args)) {
    writeJson({
      schemaVersion: 1,
      planHash: plan.planHash,
      mutationCount: plan.mutationCount,
      dispatching: plan.dispatching.length,
      waiting: plan.waiting.length,
      queued: plan.queued.length,
      workers: plan.workers.map((w) => ({ id: w.id, reason: w.reason })),
    });
    return ExitCode.OK;
  }

  heading("ChatGPT MCP Recovery");
  blank();
  console.log("Detected:");
  blank();

  let hasIssues = false;
  if (plan.dispatching.length) {
    hasIssues = true;
    console.log(
      `  ${warnMark()} ${plan.dispatching.length} task(s) stuck in DISPATCHING`
    );
  }
  if (plan.waiting.length) {
    hasIssues = true;
    console.log(
      `  ${warnMark()} ${plan.waiting.length} task(s) in WAITING_APPROVAL`
    );
  }
  if (plan.workers.length) {
    hasIssues = true;
    for (const w of plan.workers) {
      console.log(
        `  ${warnMark()} Worker ${w.id} needs reset (${w.reason})`
      );
    }
  }
  if (plan.queued.length && failQueued) {
    console.log(
      `  ${warnMark()} ${plan.queued.length} QUEUED task(s) will fail`
    );
  }

  if (!hasIssues && plan.mutationCount <= 1) {
    console.log(`  ${okMark()} No stuck tasks or workers detected`);
    console.log(`  ${okMark()} Lease reaper will still run`);
  }

  blank();
  console.log("Recommended repair:");
  if (plan.dispatching.length) console.log("  • Reset stuck dispatch");
  if (plan.workers.length) console.log("  • Reset worker state");
  if (!failQueued) console.log("  • Preserve queued tasks");
  if (failQueued) console.log("  • Fail queued tasks (--reset-queue)");
  if (failOpen) console.log("  • Fail all open tasks (--all)");
  blank();

  if (!yes) {
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question("Proceed? [Y/n] ");
      if (answer.trim().toLowerCase() === "n") {
        console.log("Cancelled.");
        return ExitCode.DECLINED;
      }
    } finally {
      rl.close();
    }
  }

  const result = executeRecover(db, plan);
  blank();
  console.log(`${okMark()} Recovery complete`);
  console.log(`  DISPATCHING → FAILED: ${result.dispatchingFailed}`);
  console.log(`  workers reset: ${result.workersReset}`);
  if (result.openTasks.length) {
    console.log(
      style(
        `  ${result.openTasks.length} open task(s) remain — gptmcp doctor`,
        "yellow"
      )
    );
  } else {
    console.log(`  ${okMark()} Queue clear`);
  }
  return ExitCode.OK;
}
