import type { TaskRepository } from "../tasks/task.repository.js";
import type { TaskService } from "../tasks/task.service.js";
import { getDatabase } from "../db/sqlite.js";
import { log } from "../logging/logger.js";
import { sanitizeChatUrl } from "../dashboard/observability.js";
import type { BrokerOpsClient } from "./broker-client.js";
import type { WorkerOperationKind } from "./worker-operation.types.js";
import { WorkerOperationsRepository } from "./worker-operations.repository.js";
import { WorkerReconciler } from "./worker-reconciler.js";

export class WorkerController {
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;

  constructor(
    private readonly opsRepo: WorkerOperationsRepository,
    private readonly reconciler: WorkerReconciler,
    private readonly taskRepo: TaskRepository,
    private readonly broker: BrokerOpsClient,
    private readonly workersFile: string
  ) {}

  static create(opts: {
    taskRepo: TaskRepository;
    taskService: TaskService;
    broker: BrokerOpsClient;
    workersFile: string;
  }): WorkerController {
    const opsRepo = new WorkerOperationsRepository(getDatabase());
    const reconciler = new WorkerReconciler(
      opsRepo,
      opts.taskRepo,
      opts.taskService,
      opts.broker,
      opts.workersFile
    );
    return new WorkerController(
      opsRepo,
      reconciler,
      opts.taskRepo,
      opts.broker,
      opts.workersFile
    );
  }

  startPeriodicReconcile(intervalMs: number): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcileAll();
    }, intervalMs);
  }

  stopPeriodicReconcile(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  async reconcileAll(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.reconciler.reconcileAll();
    } finally {
      this.reconciling = false;
    }
  }

  private enqueue(
    workerId: string,
    kind: WorkerOperationKind,
    payload: Record<string, unknown>
  ): { operationId: string } {
    this.taskRepo.assertWorkerIdle(workerId);
    if (this.opsRepo.hasActiveForWorker(workerId)) {
      throw new Error(
        `Worker ${workerId} already has an active operation — wait or retry later`
      );
    }
    this.taskRepo.beginWorkerUrlMutation(workerId);
    const op = this.opsRepo.create({
      workerId,
      kind,
      payload,
    });
    log({
      event: "INFO",
      component: "worker-controller",
      message: `WORKER_OP_ENQUEUED op=${op.id} kind=${kind} worker=${workerId}`,
      data: { operationId: op.id, workerId },
    });
    void this.reconciler.reconcileOne(op.id);
    return { operationId: op.id };
  }

  assignUrl(workerId: string, workerUrl: string): { operationId: string } {
    const url = sanitizeChatUrl(workerUrl);
    if (!url) throw new Error("invalid workerUrl");
    const state = this.taskRepo.getWorkerState(workerId);
    return this.enqueue(workerId, "ASSIGN_URL", {
      desiredWorkerUrl: url,
      previousWorkerUrl: state.workerUrl ?? "",
    });
  }

  createChat(workerId: string, bootstrapMessage?: string): { operationId: string } {
    const state = this.taskRepo.getWorkerState(workerId);
    return this.enqueue(workerId, "CREATE_CHAT", {
      previousWorkerUrl: state.workerUrl ?? "",
      bootstrapMessage,
    });
  }

  killRecreate(
    workerId: string,
    mode: "create" | "assign",
    workerUrl?: string
  ): { operationId: string } {
    const state = this.taskRepo.getWorkerState(workerId);
    const payload: Record<string, unknown> = {
      previousWorkerUrl: state.workerUrl ?? "",
      createMode: mode,
      unbound: false,
    };
    if (mode === "assign") {
      const url = sanitizeChatUrl(workerUrl ?? "");
      if (!url) throw new Error("workerUrl required for assign mode");
      payload.desiredWorkerUrl = url;
    }
    return this.enqueue(workerId, "KILL_RECREATE", payload);
  }

  retryVerify(workerId: string): { operationId: string } {
    const active = this.opsRepo.listActiveForWorker(workerId);
    if (active.length > 0) {
      const op = active[0]!;
      void this.reconciler.reconcileOne(op.id);
      return { operationId: op.id };
    }
    const state = this.taskRepo.getWorkerState(workerId);
    const url = sanitizeChatUrl(state.workerUrl ?? "");
    if (!url) throw new Error("worker has no URL to verify");
    return this.enqueue(workerId, "ASSIGN_URL", {
      desiredWorkerUrl: url,
      previousWorkerUrl: state.workerUrl ?? "",
      registryEnsured: true,
      dbEnsured: true,
      brokerEnsured: true,
    });
  }

  setEnabled(workerId: string, enabled: boolean): void {
    this.taskRepo.setWorkerDisabled(workerId, !enabled);
    if (!enabled) {
      void this.broker.unbind(workerId).catch(() => undefined);
    }
  }
}
