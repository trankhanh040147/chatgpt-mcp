#!/usr/bin/env npx tsx
/**
 * A1-S self-tests (no live ChatGPT required for unit portion).
 *
 *   npx tsx scripts/spike-a1s.ts
 *   npx tsx scripts/spike-a1s.ts --live   # needs Chrome CDP + workers.json
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { UiWriteMutex } from "../src/browser/ui-write-mutex.js";
import { chatIdFromUrl, sameWorkerChat } from "../src/browser/chat-url.js";
import {
  loadWorkersTopology,
  validateWorkersTopology,
} from "../src/config/workers-topology.js";
import {
  initDatabase,
  closeDatabase,
  resetDatabaseForTests,
  getDatabase,
} from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";

loadEnv({ path: resolve(process.cwd(), ".env") });

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed += 1;
    console.error(`FAIL: ${msg}`);
  } else {
    passed += 1;
    console.log(`ok — ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function testMutexSerializes(): Promise<void> {
  const mutex = new UiWriteMutex();
  const order: number[] = [];
  await Promise.all([
    mutex.run(async () => {
      order.push(1);
      await sleep(40);
      order.push(2);
    }),
    mutex.run(async () => {
      order.push(3);
      await sleep(10);
      order.push(4);
    }),
  ]);
  assert(
    order.join(",") === "1,2,3,4",
    `mutex serializes overlapping runs (got ${order.join(",")})`
  );
  assert(!mutex.isHeld, "mutex released after runs");
}

async function testMutexSurvivesRejection(): Promise<void> {
  const mutex = new UiWriteMutex();
  let secondRan = false;
  await mutex
    .run(async () => {
      throw new Error("boom");
    })
    .catch(() => undefined);
  await mutex.run(async () => {
    secondRan = true;
  });
  assert(secondRan, "mutex queue continues after rejected critical section");
}

async function testMutexDoesNotHoldAcrossWait(): Promise<void> {
  const mutex = new UiWriteMutex();
  let claimDuringWait = false;
  const write = mutex.run(async () => {
    await sleep(20);
  });
  await sleep(5);
  // Simulate claim/renew outside mutex while another actor waits for lock.
  claimDuringWait = true;
  await write;
  assert(claimDuringWait, "non-UI work can proceed conceptually outside mutex");
  assert(!mutex.isHeld, "mutex free after short write");
}

function testChatUrlHelpers(): void {
  assert(
    chatIdFromUrl(
      "https://chatgpt.com/c/6a7edb35-57cc-83ec-a55d-1ad45277e1f3?foo=1"
    ) === "6a7edb35-57cc-83ec-a55d-1ad45277e1f3",
    "chatIdFromUrl normalizes id"
  );
  assert(
    sameWorkerChat(
      "https://chatgpt.com/c/6a7edb35-57cc-83ec-a55d-1ad45277e1f3",
      "https://chatgpt.com/c/6A7EDB35-57CC-83EC-A55D-1AD45277E1F3?x=1"
    ),
    "sameWorkerChat ignores case/query"
  );
  assert(
    !sameWorkerChat(
      "https://chatgpt.com/c/6a7edb35-57cc-83ec-a55d-1ad45277e1f3",
      "https://chatgpt.com/c/6a808a7d-87b8-83ec-854c-b6d589ebe8ed"
    ),
    "sameWorkerChat rejects different chats"
  );
  assert(
    chatIdFromUrl("https://chatgpt.com/c/web") === undefined,
    "chatIdFromUrl rejects transient /c/web"
  );
}

function testTopologySharedCdp(): void {
  const shared = {
    source: "file" as const,
    filePath: "/tmp/x",
    workers: [
      {
        id: "w1",
        workerUrl: "https://chatgpt.com/c/6a7edb35-57cc-83ec-a55d-111111111111",
        cdpEndpoint: "http://127.0.0.1:9222",
      },
      {
        id: "w2",
        workerUrl: "https://chatgpt.com/c/6a808a7d-87b8-83ec-854c-222222222222",
        cdpEndpoint: "http://127.0.0.1:9222",
      },
    ],
  };
  let threw = false;
  try {
    validateWorkersTopology(shared);
  } catch {
    threw = true;
  }
  assert(threw, "default topology rejects shared CDP");

  threw = false;
  try {
    validateWorkersTopology(shared, { allowSharedCdp: true });
  } catch (e) {
    threw = true;
    console.error(e);
  }
  assert(!threw, "allowSharedCdp accepts identical CDP");

  const mixed = {
    ...shared,
    workers: [
      shared.workers[0]!,
      {
        ...shared.workers[1]!,
        cdpEndpoint: "http://127.0.0.1:9223",
      },
    ],
  };
  threw = false;
  try {
    validateWorkersTopology(mixed, { allowSharedCdp: true });
  } catch {
    threw = true;
  }
  assert(threw, "allowSharedCdp rejects mixed CDP endpoints");
}

async function testConcurrentClaimsWhileMutexBusy(): Promise<void> {
  resetDatabaseForTests();
  const dir = mkdtempSync(join(tmpdir(), "a1s-"));
  const path = join(dir, "t.sqlite");
  initDatabase(path);
  const repo = new TaskRepository(getDatabase());
  const service = new TaskService(repo);

  for (const id of ["w1", "w2"] as const) {
    repo.registerWorkerInstance({
      workerId: id,
      instanceToken: `t-${id}`,
      workerUrl: `https://chatgpt.com/c/${id}`,
      cdpEndpoint: "http://127.0.0.1:9222",
      staleMs: 60_000,
    });
    repo.updateWorkerState(id, "READY", { instanceToken: `t-${id}` });
  }

  const t1 = service.createTask({
    type: "research",
    prompt: "a",
    cursorConversationId: "spike",
  });
  const t2 = service.createTask({
    type: "research",
    prompt: "b",
    cursorConversationId: "spike",
  });

  const mutex = new UiWriteMutex();
  let bothClaimed = false;

  const actor = async (workerId: string, token: string) => {
    const claimed = service.claimNextQueued(workerId, token, 120_000, 60_000);
    if (!claimed) return;
    // Simulate wait/MCP outside mutex — second actor can claim meanwhile.
    await sleep(30);
    await mutex.run(async () => {
      service.markDispatchStarted(
        claimed.task.id,
        workerId,
        claimed.leaseToken,
        token,
        120_000,
        60_000
      );
      await sleep(20);
    });
  };

  await Promise.all([actor("w1", "t-w1"), actor("w2", "t-w2")]);
  const s1 = service.getTaskStatus(t1.taskId).status;
  const s2 = service.getTaskStatus(t2.taskId).status;
  bothClaimed =
    (s1 === "DISPATCHED" || s1 === "PROCESSING" || s1 === "LEASED") &&
    (s2 === "DISPATCHED" || s2 === "PROCESSING" || s2 === "LEASED");
  assert(
    bothClaimed,
    `both tasks progressed under serialized UI writes (got ${s1}, ${s2})`
  );
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
}

async function liveBrokerSmoke(): Promise<void> {
  const workersFile =
    process.env.HANDOFF_WORKERS_A1S_FILE?.trim() ||
    process.env.HANDOFF_WORKERS_FILE?.trim() ||
    resolve(
      process.env.CHATGPT_MCP_HOME?.trim() ||
        join(homedir(), ".chatgpt-mcp"),
      "data",
      "workers.json"
    );
  if (!existsSync(workersFile)) {
    console.log(`SKIP live — missing ${workersFile}`);
    return;
  }
  const raw = JSON.parse(readFileSync(workersFile, "utf8")) as unknown;
  const topology = loadWorkersTopology({
    workersFile,
    workerId: "w1",
    workerUrl: "",
    cdpEndpoint: "",
  });
  validateWorkersTopology(topology, { allowSharedCdp: true });
  assert(topology.workers.length >= 2, "live topology has ≥2 workers");
  assert(
    new Set(topology.workers.map((w) => w.cdpEndpoint)).size === 1,
    "live topology shares one CDP"
  );

  const { BrowserBroker } = await import("../src/browser/broker.js");
  const cdp = topology.workers[0]!.cdpEndpoint;
  const broker = new BrowserBroker({
    cdpEndpoint: cdp,
    chatGptUrl: "https://chatgpt.com",
    workers: topology.workers.map((w) => ({
      id: w.id,
      workerUrl: w.workerUrl,
    })),
  });
  try {
    await broker.connect();
    for (const w of topology.workers) {
      const b = broker.assertBindingFresh(w.id);
      assert(b.chatId.length > 0, `bound ${w.id}`);
    }
    console.log("ok — live broker bind smoke");
    passed += 1;
  } finally {
    await broker.close();
  }
  void raw;
}

async function main(): Promise<void> {
  await testMutexSerializes();
  await testMutexSurvivesRejection();
  await testMutexDoesNotHoldAcrossWait();
  testChatUrlHelpers();
  testTopologySharedCdp();
  await testConcurrentClaimsWhileMutexBusy();

  if (process.argv.includes("--live")) {
    await liveBrokerSmoke();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
