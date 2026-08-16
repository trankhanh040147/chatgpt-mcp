#!/usr/bin/env npx tsx
/**
 * Assisted create-worker (0.3 Track B, consent model A).
 *
 *   npx tsx scripts/create-worker.ts
 *   npx tsx scripts/create-worker.ts --id=w3 --workers-file=data/workers.a1s.json
 *   npx tsx scripts/create-worker.ts --worker-url=https://chatgpt.com/c/...  # skip CDP create
 *   npx tsx scripts/create-worker.ts --skip-canary
 *   npx tsx scripts/create-worker.ts --yes   # non-interactive pauses (CI-ish)
 *
 * Never auto-login or auto-approve MCP writes.
 */
import { config as loadEnv } from "dotenv";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { loadConfig } from "../src/config/load-config.js";
import {
  loadWorkersTopology,
  type WorkerRegistryEntry,
} from "../src/config/workers-topology.js";
import {
  nextWorkerId,
  upsertWorkerRegistryEntry,
} from "../src/config/write-workers-topology.js";
import { createWorkerChat } from "../src/browser/create-chat.js";
import { ChatGptBrowser } from "../src/browser/chatgpt.js";
import { initDatabase, getDatabase, closeDatabase } from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";
import { chatIdFromUrl } from "../src/browser/chat-url.js";

loadEnv({ path: resolve(process.cwd(), ".env") });

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function pause(message: string, skip: boolean): Promise<void> {
  console.log(`\n${message}`);
  if (skip) {
    console.log("( --yes: continuing without wait )");
    return;
  }
  const rl = createInterface({ input, output });
  try {
    await rl.question("Press Enter to continue… ");
  } finally {
    rl.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function canaryToken(): string {
  return `cw-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 10);
}

async function runCanary(opts: {
  dbPath: string;
  workerUrl: string;
  cdpEndpoint: string;
  chatGptUrl: string;
  timeoutMs: number;
}): Promise<void> {
  initDatabase(opts.dbPath);
  const repo = new TaskRepository(getDatabase());
  const service = new TaskService(repo);
  const canary = canaryToken();
  const prompt = [
    "This is an automated create-worker canary for chatgpt-mcp.",
    "Do the following and nothing else:",
    "1. If needed, call handoff_get_task with the TASK_ID from the chat message.",
    "2. Immediately call handoff_submit_result with:",
    `   - result: exactly one line: CREATE_WORKER_CANARY=${canary}`,
    '   - metadata.summary: "create-worker canary ok"',
    '   - metadata.confidence: "high"',
    "3. Do not put any other text in the result string. Exact match required.",
  ].join("\n");

  const workerId = "create-worker-canary";
  const instanceToken = `inst_cw_${randomBytes(8).toString("hex")}`;
  repo.registerWorkerInstance({
    workerId,
    instanceToken,
    workerUrl: opts.workerUrl,
    cdpEndpoint: opts.cdpEndpoint,
    staleMs: 120_000,
    pid: process.pid,
  });
  repo.updateWorkerState(workerId, "READY", { instanceToken });

  const { taskId } = service.createTask({
    type: "research",
    prompt,
    cursorConversationId: `create-worker-${Date.now()}`,
  });
  console.log(
    JSON.stringify({
      event: "CREATE_WORKER_CANARY_CREATED",
      taskId,
      canaryHash: shortHash(canary),
    })
  );

  const claimed = service.claimNextQueued(
    workerId,
    instanceToken,
    300_000,
    120_000
  );
  if (!claimed || claimed.task.id !== taskId) {
    throw new Error(
      "Canary claim race: another worker claimed first. Stop browser-broker / browser-workers and retry, or use --skip-canary."
    );
  }

  const browser = new ChatGptBrowser({
    cdpEndpoint: opts.cdpEndpoint,
    workerUrl: opts.workerUrl,
    chatGptUrl: opts.chatGptUrl,
  });
  try {
    await browser.connect();
    const ready = await browser.ensureSessionReady();
    if (!ready) {
      throw new Error("SESSION_NOT_READY during canary");
    }
    await browser.openWorkerConversation();
    const fenced = service.markDispatchStarted(
      taskId,
      workerId,
      claimed.leaseToken,
      instanceToken,
      300_000,
      120_000
    );
    if (!fenced) {
      throw new Error("Canary dispatch fence failed");
    }
    await browser.submitTaskId(taskId);

    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
      const { status } = service.getTaskStatus(taskId);
      if (status === "COMPLETED") {
        const row = repo.getTaskById(taskId)!;
        const expected = `CREATE_WORKER_CANARY=${canary}`;
        if ((row.result ?? "").trim() !== expected) {
          throw new Error(
            `Canary mismatch: got=${JSON.stringify(row.result)} want=${expected}`
          );
        }
        console.log(
          JSON.stringify({
            event: "CREATE_WORKER_CANARY_OK",
            taskId,
            canaryHash: shortHash(canary),
          })
        );
        return;
      }
      if (
        status === "FAILED" ||
        status === "TIMED_OUT" ||
        status === "CANCELLED"
      ) {
        throw new Error(
          `Canary ${status}: ${repo.getTaskById(taskId)?.error ?? ""}`
        );
      }
      await sleep(1000);
    }
    throw new Error(`Canary timeout after ${opts.timeoutMs}ms`);
  } finally {
    await browser.close().catch(() => undefined);
    try {
      closeDatabase();
    } catch {
      // ignore
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const yes = hasFlag("yes");
  const skipCanary = hasFlag("skip-canary");
  const replace = hasFlag("replace");
  const workersFile =
    argValue("workers-file") ||
    process.env.HANDOFF_WORKERS_FILE?.trim() ||
    resolve(process.cwd(), "data/workers.a1s.json");
  const cdpEndpoint =
    argValue("cdp") ||
    config.cdpEndpoint ||
    "http://127.0.0.1:9222";
  const providedUrl = argValue("worker-url");

  let existing: WorkerRegistryEntry[] = [];
  if (existsSync(workersFile)) {
    const topo = loadWorkersTopology({
      workersFile,
      workerId: "w1",
      workerUrl: "",
      cdpEndpoint: "",
    });
    existing = topo.workers;
  }

  const workerId = argValue("id") || nextWorkerId(existing);
  const sharedCdp =
    existing.length === 0
      ? cdpEndpoint
      : existing[0]!.cdpEndpoint || cdpEndpoint;

  console.log(
    JSON.stringify({
      event: "CREATE_WORKER_START",
      workerId,
      workersFile,
      cdpEndpoint: sharedCdp,
      skipCanary,
    })
  );

  await pause(
    "Ensure CDP Chrome is running, logged into ChatGPT, and Remote MCP is reachable.\n" +
      "This tool will open a New chat (or use --worker-url). It will NOT log in or approve MCP.",
    yes
  );

  let workerUrl = providedUrl?.trim() ?? "";
  let detachBrowser: (() => Promise<void>) | null = null;

  if (!workerUrl) {
    const created = await createWorkerChat({
      cdpEndpoint: sharedCdp,
      chatGptUrl: config.chatGptUrl,
    });
    workerUrl = created.workerUrl;
    detachBrowser = async () => {
      try {
        await created.browser.close();
      } catch {
        // ignore
      }
    };
    console.log(
      JSON.stringify({
        event: "CREATE_WORKER_CHAT_CAPTURED",
        workerUrl,
        chatId: created.chatId,
      })
    );
  } else {
    const id = chatIdFromUrl(workerUrl);
    if (!id) {
      throw new Error(`Invalid --worker-url (need /c/<id>): ${workerUrl}`);
    }
    workerUrl = `https://chatgpt.com/c/${id}`;
  }

  const entry: WorkerRegistryEntry = {
    id: workerId,
    workerUrl,
    cdpEndpoint: sharedCdp,
  };

  const written = upsertWorkerRegistryEntry({
    filePath: workersFile,
    entry,
    replace,
  });
  console.log(
    JSON.stringify({
      event: "CREATE_WORKER_REGISTRY_WRITTEN",
      filePath: written.filePath,
      workers: written.workers.map((w) => w.id),
    })
  );

  await pause(
    [
      "In ChatGPT (this new worker chat):",
      "  1. Open connector / Remote MCP settings for this conversation.",
      "  2. Approve WRITE tools (handoff_get_task, handoff_submit_result) if prompted.",
      "  3. Confirm the tunnel / remote-mcp URL is the one this machine serves.",
      "",
      "Do NOT skip approval — canary will fail closed without it.",
    ].join("\n"),
    yes
  );

  if (!skipCanary) {
    const timeoutMs = Number(process.env.CREATE_WORKER_CANARY_MS ?? 300_000);
    try {
      await runCanary({
        dbPath: config.dbPath,
        workerUrl,
        cdpEndpoint: sharedCdp,
        chatGptUrl: config.chatGptUrl,
        timeoutMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          event: "CREATE_WORKER_CANARY_FAIL",
          message,
          hint:
            "Registry entry was kept. Fix MCP approve / tunnel, then re-run canary " +
            `with --worker-url=${workerUrl} --id=${workerId} --replace, or remove the entry manually.`,
        })
      );
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(
      JSON.stringify({
        event: "CREATE_WORKER_CANARY_SKIPPED",
      })
    );
  }

  console.log(
    JSON.stringify({
      event: "CREATE_WORKER_DONE",
      ok: true,
      workerId,
      workerUrl,
      next: "Restart browser-broker (./scripts/start-broker-stack.sh) so the new actor binds.",
    })
  );

  if (detachBrowser) await detachBrowser();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
