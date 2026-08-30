import type { TaskRepository } from "../tasks/task.repository.js";
import type { TaskService } from "../tasks/task.service.js";
import { getDatabase } from "../db/sqlite.js";
import { log } from "../logging/logger.js";
import { sanitizeChatUrl } from "../dashboard/observability.js";
import { setWorkerRegistryEnabled, removeWorkerRegistryEntry } from "../config/write-workers-topology.js";
import { loadWorkersTopology } from "../config/workers-topology.js";
import type { BrokerOpsClient } from "./broker-client.js";
import type { WorkerOperationKind } from "./worker-operation.types.js";
import type { WorkerOperation } from "./worker-operation.types.js";
import type { WorkerReadinessReason } from "../workers/chat-budget.js";
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
    const state = this.taskRepo.getWorkerState(workerId);
    if (state.error === "DISABLED") {
      throw new Error(`Worker ${workerId} is disabled — enable before worker ops`);
    }
    const op = this.opsRepo.enqueueWithReservation({
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
    void this.reconcileAll();
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
    this.prepareForNewChat(workerId);
    const state = this.taskRepo.getWorkerState(workerId);
    return this.enqueue(workerId, "CREATE_CHAT", {
      previousWorkerUrl: state.workerUrl ?? "",
      bootstrapMessage,
    });
  }

  /** New chat supersedes stuck handoffs and prior worker ops — always allowed. */
  private prepareForNewChat(workerId: string): void {
    void this.broker.cancelUi(workerId).catch(() => undefined);
    this.cancelActiveOperation(workerId, "superseded by new chat");
    const cleared = this.taskRepo.failInFlightTasksForWorker(
      workerId,
      "cleared for new chat"
    );
    if (cleared.length > 0) {
      log({
        event: "INFO",
        component: "worker-controller",
        message: `NEW_CHAT cleared in-flight tasks worker=${workerId} tasks=${cleared.join(",")}`,
        data: { workerId, taskIds: cleared },
      });
    }
  }

  killRecreate(
    workerId: string,
    mode: "create" | "assign",
    workerUrl?: string
  ): { operationId: string } {
    if (mode === "create") {
      this.prepareForNewChat(workerId);
    }
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
      void this.reconcileAll();
      return { operationId: active[0]!.id };
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
    setWorkerRegistryEnabled({
      filePath: this.workersFile,
      workerId,
      enabled,
    });
    this.taskRepo.setWorkerDisabled(workerId, !enabled);
    if (!enabled) {
      this.cancelActiveOperation(workerId, "disabled by operator");
      void this.broker.cancelUi(workerId).catch(() => undefined);
      void this.broker.unbind(workerId).catch(() => undefined);
    }
  }

  removeWorker(workerId: string): void {
    if (!workerId || workerId === "default") {
      throw new Error(`Cannot remove worker id: ${workerId || "(empty)"}`);
    }
    this.cancelActiveOperation(workerId, "worker removed");
    this.taskRepo.failInFlightTasksForWorker(workerId, "worker removed");
    void this.broker.unbind(workerId).catch(() => undefined);
    void this.broker.cancelUi(workerId).catch(() => undefined);

    const topology = loadWorkersTopology({
      workersFile: this.workersFile,
      workerId: workerId,
      workerUrl: "",
      cdpEndpoint: "",
    });
    const inRegistry = topology.workers.some((w) => w.id === workerId);
    if (inRegistry) {
      removeWorkerRegistryEntry({
        filePath: this.workersFile,
        workerId,
      });
    }

    const deleted = this.taskRepo.deleteWorkerState(workerId);
    if (!deleted && !inRegistry) {
      throw new Error(`Worker ${workerId} not found in registry or database`);
    }

    log({
      event: "INFO",
      component: "worker-controller",
      message: `WORKER_REMOVED id=${workerId} registry=${inRegistry}`,
      data: { workerId, inRegistry },
    });
  }

  releaseStuckTask(workerId: string): { taskIds: string[] } {
    const taskIds = this.taskRepo.failInFlightTasksForWorker(
      workerId,
      "released stuck task from ops dashboard"
    );
    log({
      event: "INFO",
      component: "worker-controller",
      message: `WORKER_STUCK_TASK_RELEASED worker=${workerId} tasks=${taskIds.join(",")}`,
      data: { workerId, taskIds },
    });
    return { taskIds };
  }

  /** Cancel active worker op + fail in-flight handoffs (dashboard Clear stuck). */
  clearStuck(workerId: string): {
    operationId: string | null;
    taskIds: string[];
  } {
    void this.broker.cancelUi(workerId).catch(() => undefined);
    const operationId = this.cancelActiveOperation(workerId, "cleared by operator");
    const taskIds = this.taskRepo.failInFlightTasksForWorker(
      workerId,
      "cleared by operator"
    );
    log({
      event: "INFO",
      component: "worker-controller",
      message: `WORKER_CLEAR_STUCK worker=${workerId} op=${operationId ?? "none"} tasks=${taskIds.join(",")}`,
      data: { workerId, operationId, taskIds },
    });
    return { operationId, taskIds };
  }

  listActiveOperations(): WorkerOperation[] {
    return this.opsRepo.listActive();
  }

  cancelOperation(workerId: string): { operationId: string } {
    const opId = this.cancelActiveOperation(workerId, "cancelled by operator");
    if (!opId) {
      throw new Error(`No active worker operation for ${workerId}`);
    }
    return { operationId: opId };
  }

  private cancelActiveOperation(workerId: string, message: string): string | null {
    const active = this.opsRepo.listActiveForWorker(workerId);
    if (active.length === 0) return null;
    const op = active[0]!;
    void this.broker.cancelUi(workerId).catch(() => undefined);
    this.opsRepo.update(op.id, {
      state: "FAILED",
      lastError: message,
    });
    const prev = op.payload.reservationPreviousReason ?? null;
    this.taskRepo.abortRotationReservation(
      workerId,
      prev as WorkerReadinessReason | null
    );
    log({
      event: "INFO",
      component: "worker-controller",
      message: `WORKER_OP_CANCELLED op=${op.id} worker=${workerId}`,
      data: { operationId: op.id, workerId },
    });
    return op.id;
  }
}
