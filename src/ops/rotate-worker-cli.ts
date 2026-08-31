/**
 * Rotate a worker ChatGPT chat (0.5). Idle-only. Does not restart the broker.
 * Application-layer entry used by gptmcp + thin scripts/rotate-worker.ts.
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config/load-config.js";
import { resolveWorkersFilePath } from "../config/load-config.js";
import { loadWorkersTopology } from "../config/workers-topology.js";
import { createWorkerChat } from "../browser/create-chat.js";
import { chatIdFromUrl } from "../browser/chat-url.js";
import { initDatabase, getDatabase, closeDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";
import { commitRotatedWorker } from "./rotate-worker.js";

export interface RotateWorkerCliOptions {
  workerId: string;
  workersFile?: string;
  workerUrl?: string;
  yes?: boolean;
  assumeConsent?: boolean;
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

export async function runRotateWorker(
  opts: RotateWorkerCliOptions
): Promise<{ ok: boolean }> {
  const config = loadConfig();
  const yes = Boolean(opts.yes);
  const assumeConsent = Boolean(opts.assumeConsent);
  const workerId = opts.workerId;

  const workersFile = resolveWorkersFilePath(opts.workersFile);
  if (!existsSync(workersFile)) {
    throw new Error(`workers file not found: ${workersFile}`);
  }

  const topo = loadWorkersTopology({
    workersFile,
    workerId,
    workerUrl: "",
    cdpEndpoint: config.cdpEndpoint,
  });
  const existing = topo.workers.find((w) => w.id === workerId);
  if (!existing) {
    throw new Error(`Worker ${workerId} not in ${workersFile}`);
  }

  initDatabase(config.dbPath);
  const repo = new TaskRepository(getDatabase());
  repo.getWorkerState(workerId);
  const reserved = repo.beginRotationReservation(workerId);

  console.log(
    JSON.stringify({
      event: "ROTATE_WORKER_START",
      workerId,
      previousWorkerUrl: existing.workerUrl,
      workersFile,
      reservedFrom: reserved.previousReason,
    })
  );

  let newUrl = opts.workerUrl?.trim() ?? "";
  let detachBrowser: (() => Promise<void>) | null = null;

  try {
    if (!newUrl) {
      await pause(
        "Ensure CDP Chrome is logged into ChatGPT. This will create a New chat\n" +
          "(Chat surface + Cursor plugin). It will NOT log in or approve MCP.",
        yes
      );
      const created = await createWorkerChat({
        cdpEndpoint: existing.cdpEndpoint || config.cdpEndpoint,
        chatGptUrl: config.chatGptUrl,
      });
      newUrl = created.workerUrl;
      detachBrowser = async () => {
        try {
          await created.browser.close();
        } catch {
          // ignore
        }
      };
      console.log(
        JSON.stringify({
          event: "ROTATE_WORKER_CHAT_CAPTURED",
          workerUrl: newUrl,
          chatId: created.chatId,
        })
      );
    } else {
      const id = chatIdFromUrl(newUrl);
      if (!id) {
        throw new Error(`Invalid --worker-url (need /c/<id>): ${newUrl}`);
      }
      newUrl = `https://chatgpt.com/c/${id}`;
    }

    const committed = commitRotatedWorker({
      repo,
      workersFile,
      workerId,
      existing,
      newWorkerUrl: newUrl,
      readinessReason: "CONSENT_REQUIRED",
    });

    console.log(
      JSON.stringify({
        event: "ROTATE_WORKER_COMMITTED",
        ...committed,
      })
    );

    await pause(
      [
        "In ChatGPT (the NEW worker chat):",
        "  1. Approve WRITE tools (handoff_get_task, handoff_submit_result) if prompted.",
        "  2. Confirm Remote MCP / tunnel for this machine.",
        "",
        "Then press Enter to mark RESTART_REQUIRED. Worker stays non-claimable",
        "until broker restart. --yes alone leaves CONSENT_REQUIRED (model A).",
        "--assume-consent is an explicit operator assertion that MCP is already approved.",
      ].join("\n"),
      yes
    );

    if (!yes || assumeConsent) {
      repo.setReadinessReason(
        workerId,
        "RESTART_REQUIRED",
        assumeConsent
          ? "RESTART_REQUIRED: operator asserted MCP already approved (--assume-consent)"
          : "RESTART_REQUIRED: restart browser-broker to bind the new chat"
      );
    }

    console.log(
      JSON.stringify({
        event: "ROTATE_WORKER_DONE",
        ok: true,
        workerId,
        newWorkerUrl: newUrl,
        readinessReason: repo.getWorkerState(workerId).readinessReason,
        next: "gptmcp restart",
      })
    );
    return { ok: true };
  } catch (err) {
    repo.abortRotationReservation(workerId, reserved.previousReason);
    throw err;
  } finally {
    if (detachBrowser) await detachBrowser();
    try {
      closeDatabase();
    } catch {
      // ignore
    }
  }
}
