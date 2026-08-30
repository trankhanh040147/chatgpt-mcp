/**
 * Worker control plane tests: atomic enqueue, reconcile concurrency, probe completion.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { WorkerController } from "../src/ops/worker-controller.js";

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

class MockBroker implements BrokerOpsClient {
  rebindCalls = 0;
  createChatCalls = 0;
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

  cancelUiCalls = 0;

  async cancelUi(_workerId: string): Promise<void> {
    this.cancelUiCalls += 1;
  }

  async createChat(
    workerId: string,
    _bootstrapMessage?: string
  ): Promise<{ workerUrl: string; chatId: string }> {
    this.createChatCalls += 1;
    const suffix = this.createChatCalls.toString().padStart(12, "0");
    const workerUrl = `https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-${suffix}`;
    await this.rebind(workerId, workerUrl);
    return {
      workerUrl,
      chatId: `aaaaaaaa-bbbb-cccc-dddd-${suffix}`,
    };
  }
}

function makeWorkersFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "workers-"));
  const path = join(dir, "workers.json");
  writeFileSync(
    path,
    JSON.stringify(
      [
        {
          id: "w1",
          workerUrl: "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
          cdpEndpoint: "http://127.0.0.1:9222",
          enabled: true,
        },
        {
          id: "w2",
          workerUrl: "https://chatgpt.com/c/22222222-3333-4444-5555-666666666666",
          cdpEndpoint: "http://127.0.0.1:9222",
          enabled: true,
        },
      ],
      null,
      2
    )
  );
  return path;
}

function freshEnv(workersFile: string): {
  repo: TaskRepository;
  service: TaskService;
  opsRepo: WorkerOperationsRepository;
  broker: MockBroker;
  reconciler: WorkerReconciler;
  dbPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "handoff-worker-ops-"));
  const dbPath = join(dir, "handoff.sqlite");
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
  repo.registerWorkerInstance({
    workerId: "w2",
    instanceToken: "inst-w2",
    workerUrl: "https://chatgpt.com/c/22222222-3333-4444-5555-666666666666",
    cdpEndpoint: "http://127.0.0.1:9222",
    staleMs: 120_000,
    pid: process.pid,
  });
  const opsRepo = new WorkerOperationsRepository(getDatabase());
  const broker = new MockBroker();
  const reconciler = new WorkerReconciler(
    opsRepo,
    repo,
    service,
    broker,
    workersFile
  );
  return { repo, service, opsRepo, broker, reconciler, dbPath };
}

function teardown(dbPath: string): void {
  closeDatabase();
  resetDatabaseForTests();
  rmSync(dbPath, { force: true });
  rmSync(join(dbPath, ".."), { recursive: true, force: true });
}

async function driveProbeToCompleted(
  service: TaskService,
  workerId: string,
  instanceToken: string,
  taskId: string,
  token: string,
  resultOverride?: string
): Promise<void> {
  const claimed = service.claimNextQueued(
    workerId,
    instanceToken,
    30_000,
    120_000
  );
  assert(claimed?.task.id === taskId, "probe claimed by target worker");
  const fenced = service.markDispatchStarted(
    taskId,
    workerId,
    claimed!.leaseToken,
    instanceToken,
    30_000,
    120_000
  );
  assert(fenced, "probe dispatch fence");
  const done = service.submitResult({
    taskId,
    result: resultOverride ?? `CREATE_WORKER_CANARY=${token}`,
  });
  assert(done.success && done.status === "COMPLETED", "probe submitted");
}

async function main(): Promise<void> {
  const workersFile = makeWorkersFile();

  // T1 — atomic enqueue: never ROTATION_PENDING without operation
  {
    const { repo, opsRepo, dbPath } = freshEnv(workersFile);
    const op = opsRepo.enqueueWithReservation({
      workerId: "w1",
      kind: "ASSIGN_URL",
      payload: {
        desiredWorkerUrl:
          "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        previousWorkerUrl:
          "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
      },
    });
    const state = repo.getWorkerState("w1");
    assert(state.readinessReason === "ROTATION_PENDING", "T1 reservation set");
    assert(opsRepo.getById(op.id)?.state === "PENDING", "T1 operation exists");

    let threw = false;
    try {
      opsRepo.enqueueWithReservation({
        workerId: "w1",
        kind: "CREATE_CHAT",
        payload: {},
      });
    } catch {
      threw = true;
    }
    assert(threw, "T1 second enqueue rejected");
    assert(
      opsRepo.listActiveForWorker("w1").length === 1,
      "T1 still one active operation"
    );
    teardown(dbPath);
  }

  // T2 — concurrent reconcile CREATE_CHAT → single createChat
  {
    const { opsRepo, broker, reconciler, dbPath } = freshEnv(workersFile);
    const op = opsRepo.enqueueWithReservation({
      workerId: "w1",
      kind: "CREATE_CHAT",
      payload: {
        previousWorkerUrl:
          "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
      },
    });
    await Promise.all([
      reconciler.reconcileOne(op.id),
      reconciler.reconcileOne(op.id),
    ]);
    assert(
      broker.createChatCalls === 1,
      "T2 concurrent reconcileOne → one createChat"
    );
    teardown(dbPath);
  }

  // T3 — verification completion → SUCCEEDED + readiness cleared
  {
    const { repo, service, opsRepo, reconciler, dbPath } = freshEnv(workersFile);
    const desired =
      "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-111111111111";
    const op = opsRepo.enqueueWithReservation({
      workerId: "w1",
      kind: "ASSIGN_URL",
      payload: {
        desiredWorkerUrl: desired,
        previousWorkerUrl:
          "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
        registryEnsured: true,
        dbEnsured: true,
        brokerEnsured: true,
      },
    });
    await reconciler.reconcileOne(op.id);
    const mid = opsRepo.getById(op.id)!;
    assert(mid.state === "VERIFYING", "T3 reached VERIFYING");
    await driveProbeToCompleted(
      service,
      "w1",
      "inst-test",
      mid.payload.probeTaskId!,
      mid.payload.probeToken!
    );
    await reconciler.reconcileOne(op.id);
    const final = opsRepo.getById(op.id)!;
    assert(final.state === "SUCCEEDED", "T3 operation SUCCEEDED");
    const w = repo.getWorkerState("w1");
    assert(
      !w.readinessReason && !w.error,
      "T3 worker readiness cleared after probe"
    );
    teardown(dbPath);
  }

  // T4 — bad probe nonce → operation not succeeded, readiness not cleared
  {
    const { repo, service, opsRepo, reconciler, dbPath } = freshEnv(workersFile);
    const op = opsRepo.enqueueWithReservation({
      workerId: "w1",
      kind: "ASSIGN_URL",
      payload: {
        desiredWorkerUrl:
          "https://chatgpt.com/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        previousWorkerUrl:
          "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
        registryEnsured: true,
        dbEnsured: true,
        brokerEnsured: true,
      },
    });
    await reconciler.reconcileOne(op.id);
    const mid = opsRepo.getById(op.id)!;
    await driveProbeToCompleted(
      service,
      "w1",
      "inst-test",
      mid.payload.probeTaskId!,
      "wrong-token"
    );
    await reconciler.reconcileOne(op.id);
    const after = opsRepo.getById(op.id)!;
    assert(after.state !== "SUCCEEDED", "T4 not SUCCEEDED on bad nonce");
    const w = repo.getWorkerState("w1");
    assert(
      w.readinessReason === "CONSENT_REQUIRED" ||
        w.readinessReason === "ROTATION_PENDING",
      "T4 readiness not cleared on bad nonce"
    );
    teardown(dbPath);
  }

  // T9 — probe accepts canary embedded in prose (ChatGPT often adds words)
  {
    const { opsRepo, reconciler, service, dbPath } = freshEnv(workersFile);
    const op = opsRepo.enqueueWithReservation({
      workerId: "w1",
      kind: "ASSIGN_URL",
      payload: {
        desiredWorkerUrl:
          "https://chatgpt.com/c/eeeeeeee-ffff-0000-1111-222222222222",
        previousWorkerUrl:
          "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
        registryEnsured: true,
        dbEnsured: true,
        brokerEnsured: true,
      },
    });
    await reconciler.reconcileOne(op.id);
    const mid = opsRepo.getById(op.id)!;
    const token = mid.payload.probeToken!;
    await driveProbeToCompleted(
      service,
      "w1",
      "inst-test",
      mid.payload.probeTaskId!,
      token,
      `Worker canary received and processed successfully: CREATE_WORKER_CANARY=${token}`
    );
    await reconciler.reconcileOne(op.id);
    assert(
      opsRepo.getById(op.id)?.state === "SUCCEEDED",
      "T9 probe succeeds when canary embedded in prose"
    );
    teardown(dbPath);
  }

  // T10 — new chat always enqueues; clears stuck handoff first
  {
    const { repo, service, opsRepo, broker, dbPath } = freshEnv(workersFile);
    const controller = WorkerController.create({
      taskRepo: repo,
      taskService: service,
      broker,
      workersFile,
    });
    const { taskId } = service.createSystemProbe({
      workerId: "w1",
      operationId: "wop_probe_busy",
      token: "deadbeef00000001",
    });
    getDatabase()
      .prepare(
        `UPDATE handoff_tasks
         SET status = 'WAITING_APPROVAL', lease_owner = 'w1'
         WHERE id = ?`
      )
      .run(taskId);
    assert(repo.getInFlightTaskId("w1") === taskId, "T10 handoff blocks before new chat");
    controller.createChat("w1");
    await controller.reconcileAll();
    assert(
      opsRepo.listActiveForWorker("w1").length === 1,
      "T10 create chat enqueued despite prior busy"
    );
    assert(repo.getInFlightTaskId("w1") === null, "T10 stuck handoff cleared");
    teardown(dbPath);
  }

  // T5 — disable persists topology.enabled (isolated workers file)
  {
    const workersFileT5 = makeWorkersFile();
    const { repo, dbPath } = freshEnv(workersFileT5);
    const controller = WorkerController.create({
      taskRepo: repo,
      taskService: new TaskService(repo),
      broker: new MockBroker(),
      workersFile: workersFileT5,
    });
    controller.setEnabled("w2", false);
    const raw = JSON.parse(readFileSync(workersFileT5, "utf-8")) as Array<{
      id: string;
      enabled?: boolean;
    }>;
    const w2 = raw.find((w) => w.id === "w2");
    assert(w2?.enabled === false, "T5 topology enabled=false");
    const state = repo.getWorkerState("w2");
    assert(state.error === "DISABLED", "T5 DB disabled");
    teardown(dbPath);
  }

  // T6 — ROTATION_FAILED allows direct retry (no Recover)
  {
    const { repo, opsRepo, dbPath } = freshEnv(workersFile);
    repo.setReadinessReason(
      "w1",
      "ROTATION_FAILED",
      "worker-op: previous fail"
    );
    const op = opsRepo.enqueueWithReservation({
      workerId: "w1",
      kind: "ASSIGN_URL",
      payload: {
        desiredWorkerUrl:
          "https://chatgpt.com/c/dddddddd-eeee-ffff-0000-111111111111",
        previousWorkerUrl:
          "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
      },
    });
    assert(op.id.startsWith("wop_"), "T6 enqueue after ROTATION_FAILED");
    assert(
      repo.getWorkerState("w1").readinessReason === "ROTATION_PENDING",
      "T6 reservation replaces failed with pending"
    );
    teardown(dbPath);
  }

  // T7 — cancel must not resurrect FAILED op on reconcile retry
  {
    const { opsRepo, broker, reconciler, dbPath } = freshEnv(workersFile);
    const op = opsRepo.enqueueWithReservation({
      workerId: "w1",
      kind: "CREATE_CHAT",
      payload: {
        previousWorkerUrl:
          "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
      },
    });
    opsRepo.update(op.id, { state: "RUNNING" });
    opsRepo.update(op.id, {
      state: "FAILED",
      lastError: "cancelled by operator",
    });
    const callsBefore = broker.createChatCalls;
    await reconciler.reconcileOne(op.id);
    assert(
      broker.createChatCalls === callsBefore,
      "T7 cancelled op not resurrected by reconcile"
    );
    assert(
      opsRepo.getById(op.id)?.state === "FAILED",
      "T7 op stays FAILED"
    );
    teardown(dbPath);
  }

  // T8 — disable cancels active op and stops broker UI
  {
    const { repo, service, opsRepo, broker, reconciler, dbPath } =
      freshEnv(workersFile);
    const controller = WorkerController.create({
      taskRepo: repo,
      taskService: service,
      broker,
      workersFile,
    });
    controller.createChat("w1");
    await controller.reconcileAll();
    const active = opsRepo.listActiveForWorker("w1");
    assert(active.length === 1, "T8 active op before disable");
    controller.setEnabled("w1", false);
    await controller.reconcileAll();
    assert(
      opsRepo.listActiveForWorker("w1").length === 0,
      "T8 disable cancels active op"
    );
    assert(broker.cancelUiCalls >= 1, "T8 disable calls cancelUi");
    assert(repo.getWorkerState("w1").error === "DISABLED", "T8 worker disabled");
    teardown(dbPath);
  }

  // Broker rebind idempotent when binding already matches
  {
    const { opsRepo, broker, reconciler, dbPath } = freshEnv(workersFile);
    const desired =
      "https://chatgpt.com/c/cccccccc-dddd-eeee-ffff-000000000001";
    const op = opsRepo.enqueueWithReservation({
      workerId: "w1",
      kind: "ASSIGN_URL",
      payload: {
        desiredWorkerUrl: desired,
        previousWorkerUrl:
          "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
      },
    });
    await reconciler.reconcileOne(op.id);
    const before = broker.rebindCalls;
    await reconciler.reconcileOne(op.id);
    assert(
      broker.rebindCalls === before,
      "broker rebind idempotent when binding matches"
    );
    teardown(dbPath);
  }

  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
