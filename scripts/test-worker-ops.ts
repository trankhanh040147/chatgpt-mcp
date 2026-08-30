/**
 * Worker control plane unit tests (journal + idempotent reconcile markers).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initDatabase,
  getDatabase,
  closeDatabase,
  resetDatabaseForTests,
} from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";
import { WorkerOperationsRepository } from "../src/ops/worker-operations.repository.js";
import type { BrokerOpsClient, BrokerStatusSnapshot } from "../src/ops/broker-client.js";
import { WorkerReconciler } from "../src/ops/worker-reconciler.js";

class MockBroker implements Pick<BrokerOpsClient, "status" | "rebind" | "unbind" | "createChat" | "ping"> {
  rebindCalls = 0;
  statusSnapshot: BrokerStatusSnapshot = {
    healthy: true,
    cdpEndpoint: "http://127.0.0.1:9222",
    connectionGeneration: 1,
    registryWorkerIds: ["w1"],
    bindings: [],
  };

  async ping(): Promise<boolean> {
    return true;
  }

  async status(): Promise<BrokerStatusSnapshot> {
    return this.statusSnapshot;
  }

  async rebind(workerId: string, workerUrl: string): Promise<void> {
    this.rebindCalls += 1;
    const chatId = workerUrl.match(/\/c\/([a-z0-9-]+)/i)?.[1] ?? "x";
    this.statusSnapshot.bindings = [
      {
        workerId,
        chatId,
        pageUrl: workerUrl,
        generation: this.rebindCalls,
      },
    ];
  }

  async unbind(_workerId: string): Promise<void> {
    this.statusSnapshot.bindings = [];
  }

  async createChat(
    workerId: string,
    _bootstrapMessage?: string
  ): Promise<{ workerUrl: string; chatId: string }> {
    const workerUrl = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await this.rebind(workerId, workerUrl);
    return {
      workerUrl,
      chatId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    };
  }
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "handoff-worker-ops-"));
  return join(dir, "handoff.sqlite");
}

async function main(): Promise<void> {
  const dbPath = tempDb();
  const workersFile = join(mkdtempSync(join(tmpdir(), "workers-")), "workers.json");
  writeFileSync(
    workersFile,
    JSON.stringify(
      [
        {
          id: "w1",
          workerUrl: "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
          cdpEndpoint: "http://127.0.0.1:9222",
        },
      ],
      null,
      2
    )
  );

  initDatabase(dbPath);
  const repo = new TaskRepository(getDatabase());
  const service = new TaskService(repo);
  repo.registerWorkerInstance({
    workerId: "w1",
    instanceToken: "inst-test",
    workerUrl: "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
    cdpEndpoint: "http://127.0.0.1:9222",
    staleMs: 120_000,
    pid: process.pid,
  });
  repo.beginWorkerUrlMutation("w1");

  const opsRepo = new WorkerOperationsRepository(getDatabase());
  const broker = new MockBroker();
  const reconciler = new WorkerReconciler(
    opsRepo,
    repo,
    service,
    broker as BrokerOpsClient,
    workersFile
  );

  const desired = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const op = opsRepo.create({
    workerId: "w1",
    kind: "ASSIGN_URL",
    payload: {
      desiredWorkerUrl: desired,
      previousWorkerUrl: "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
    },
  });

  // M6: registry step then resume
  await reconciler.reconcileOne(op.id);
  let current = opsRepo.getById(op.id)!;
  if (!current.payload.registryEnsured) {
    throw new Error("M6: expected registryEnsured after first reconcile");
  }

  // Simulate crash before db — reset markers except registry
  opsRepo.update(op.id, {
    state: "PENDING",
    payload: {
      ...current.payload,
      dbEnsured: false,
      brokerEnsured: false,
    },
  });
  await reconciler.reconcileOne(op.id);
  current = opsRepo.getById(op.id)!;
  if (!current.payload.dbEnsured) {
    throw new Error("M7: expected dbEnsured after resume");
  }

  // M10: idempotent broker ensure
  const before = broker.rebindCalls;
  await reconciler.reconcileOne(op.id);
  if (broker.rebindCalls !== before) {
    throw new Error("M10: broker rebind should be idempotent when already bound");
  }

  console.log("test-worker-ops: all checks passed");
  closeDatabase();
  resetDatabaseForTests();
  rmSync(dbPath, { force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
