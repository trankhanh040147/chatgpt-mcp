import type { TaskRepository } from "../tasks/task.repository.js";
import type { TaskService } from "../tasks/task.service.js";
import { existsSync } from "node:fs";
import { getDatabase } from "../db/sqlite.js";
import { log } from "../logging/logger.js";
import { sanitizeChatUrl } from "../dashboard/observability.js";
import { setWorkerRegistryEnabled, removeWorkerRegistryEntry } from "../config/write-workers-topology.js";
import { workersTopologySource } from "../config/workers-topology.js";
import { loadWorkersTopology } from "../config/workers-topology.js";
import {
  defaultWorkersFilePath,
  resolveWorkersFilePath,
  workersFileBesideDb,
} from "../config/load-config.js";
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
    this.prepareForAssignUrl(workerId);
    const url = sanitizeChatUrl(workerUrl);
    if (!url) throw new Error("invalid workerUrl");
    const state = this.taskRepo.getWorkerState(workerId);
    return this.enqueue(workerId, "ASSIGN_URL", {
      desiredWorkerUrl: url,
      previousWorkerUrl: state.workerUrl ?? "",
    });
  }

  createChat(workerId: string, bootstrapMessage?: string): { operationId: string } {
    const inFlightCreate = this.opsRepo
      .listActiveForWorker(workerId)
      .find(
        (op) =>
          op.kind === "CREATE_CHAT" &&
          !op.payload.desiredWorkerUrl &&
          (op.state === "PENDING" || op.state === "RUNNING")
      );
    if (inFlightCreate) {
      log({
        event: "INFO",
        component: "worker-controller",
        message: `CREATE_CHAT already in flight op=${inFlightCreate.id} worker=${workerId}`,
        data: { operationId: inFlightCreate.id, workerId },
      });
      return { operationId: inFlightCreate.id };
    }
    this.prepareForNewChat(workerId);
    const state = this.taskRepo.getWorkerState(workerId);
    return this.enqueue(workerId, "CREATE_CHAT", {
      previousWorkerUrl: state.workerUrl ?? "",
      bootstrapMessage,
    });
  }

  /** Assign URL supersedes a stuck VERIFYING/RUNNING worker op (not handoff tasks). */
  private prepareForAssignUrl(workerId: string): void {
    void this.broker.cancelUi(workerId).catch(() => undefined);
    const cancelled = this.cancelActiveOperation(
      workerId,
      "superseded by assign url"
    );
    if (cancelled) {
      log({
        event: "INFO",
        component: "worker-controller",
        message: `ASSIGN_URL superseded op=${cancelled} worker=${workerId}`,
        data: { workerId, operationId: cancelled },
      });
    }
  }

  /** New chat supersedes stuck handoffs and prior worker ops — always allowed. */
  private prepareForNewChat(workerId: string): void {
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
    return this.continueConnection(workerId);
  }

  /** One bounded verification attempt — supersedes stuck ops and in-flight handoffs. */
  continueConnection(workerId: string): { operationId: string } {
    void this.broker.cancelUi(workerId).catch(() => undefined);
    const cancelled = this.cancelActiveOperation(
      workerId,
      "superseded by continue connection"
    );
    const cleared = this.taskRepo.failInFlightTasksForWorker(
      workerId,
      "cleared for continue connection"
    );
    if (cancelled || cleared.length > 0) {
      log({
        event: "INFO",
        component: "worker-controller",
        message: `CONTINUE_CONNECTION worker=${workerId} cancelledOp=${cancelled ?? "none"} clearedTasks=${cleared.join(",")}`,
        data: { workerId, operationId: cancelled, taskIds: cleared },
      });
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
    if (workersTopologySource() === "file") {
      setWorkerRegistryEnabled({
        filePath: this.workersFile,
        workerId,
        enabled,
      });
    }
    this.taskRepo.setWorkerDisabled(workerId, !enabled);
    if (!enabled) {
      this.cancelActiveOperation(workerId, "disabled by operator");
      void this.broker.cancelUi(workerId).catch(() => undefined);
      void this.broker.unbind(workerId).catch(() => undefined);
    }
  }

  async removeWorker(workerId: string): Promise<void> {
    if (!workerId || workerId === "default") {
      throw new Error(`Cannot remove worker id: ${workerId || "(empty)"}`);
    }
    this.cancelAllActiveOperations(workerId, "worker removed");
    this.taskRepo.failInFlightTasksForWorker(workerId, "worker removed");
    await this.broker.cancelUi(workerId).catch(() => undefined);
    await this.broker.despawnActor(workerId).catch(() => undefined);
    await this.broker.unbind(workerId).catch(() => undefined);

    let removedFromRegistry = false;
    if (workersTopologySource() === "file") {
      for (const filePath of this.registryFilePaths()) {
        try {
          const topo = loadWorkersTopology({
            workersFile: filePath,
            workerId,
            workerUrl: "",
            cdpEndpoint: "",
          });
          if (!topo.workers.some((w) => w.id === workerId)) continue;
          removeWorkerRegistryEntry({ filePath, workerId });
          removedFromRegistry = true;
        } catch {
          /* skip missing legacy file */
        }
      }
    }

    const deleted = this.taskRepo.deleteWorkerState(workerId);
    if (!deleted && !removedFromRegistry) {
      throw new Error(`Worker ${workerId} not found in database`);
    }

    log({
      event: "INFO",
      component: "worker-controller",
      message: `WORKER_REMOVED id=${workerId} legacyFile=${removedFromRegistry} db=${deleted}`,
      data: { workerId, removedFromRegistry, deleted },
    });
  }

  /** Primary workers file plus sibling-of-DB when split during migration. */
  private registryFilePaths(): string[] {
    const paths = new Set<string>();
    paths.add(this.workersFile);
    const beside = workersFileBesideDb();
    if (beside) paths.add(beside);
    const home = defaultWorkersFilePath();
    if (existsSync(home)) paths.add(home);
    return [...paths];
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
    void this.broker.cancelUi(workerId).catch(() => undefined);
    let firstId: string | null = null;
    for (const op of active) {
      this.opsRepo.update(op.id, {
        state: "FAILED",
        lastError: message,
      });
      const prev = op.payload.reservationPreviousReason ?? null;
      this.taskRepo.abortRotationReservation(
        workerId,
        prev as WorkerReadinessReason | null
      );
      if (!firstId) firstId = op.id;
      log({
        event: "INFO",
        component: "worker-controller",
        message: `WORKER_OP_CANCELLED op=${op.id} worker=${workerId}`,
        data: { operationId: op.id, workerId },
      });
    }
    return firstId;
  }

  private cancelAllActiveOperations(workerId: string, message: string): string[] {
    const active = this.opsRepo.listActiveForWorker(workerId);
    if (active.length === 0) return [];
    void this.broker.cancelUi(workerId).catch(() => undefined);
    const ids: string[] = [];
    for (const op of active) {
      this.opsRepo.update(op.id, {
        state: "FAILED",
        lastError: message,
      });
      const prev = op.payload.reservationPreviousReason ?? null;
      this.taskRepo.abortRotationReservation(
        workerId,
        prev as WorkerReadinessReason | null
      );
      ids.push(op.id);
      log({
        event: "INFO",
        component: "worker-controller",
        message: `WORKER_OP_CANCELLED op=${op.id} worker=${workerId}`,
        data: { operationId: op.id, workerId },
      });
    }
    return ids;
  }
}
