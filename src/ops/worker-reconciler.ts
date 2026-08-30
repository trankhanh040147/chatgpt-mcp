import { createHash, randomBytes } from "node:crypto";
import type { WorkerRegistryEntry } from "../config/workers-topology.js";
import { loadWorkersTopology } from "../config/workers-topology.js";
import { upsertWorkerRegistryEntry } from "../config/write-workers-topology.js";
import { sanitizeChatUrl } from "../dashboard/observability.js";
import { chatIdFromUrl } from "../browser/chat-url.js";
import { log } from "../logging/logger.js";
import type { TaskRepository } from "../tasks/task.repository.js";
import type { TaskService } from "../tasks/task.service.js";
import type { BrokerOpsClient } from "./broker-client.js";
import type { WorkerOperationsRepository } from "./worker-operations.repository.js";
import type {
  WorkerOperation,
  WorkerOperationPayload,
} from "./worker-operation.types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function probeToken(): string {
  return randomBytes(16).toString("hex");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export class WorkerReconciler {
  constructor(
    private readonly opsRepo: WorkerOperationsRepository,
    private readonly taskRepo: TaskRepository,
    private readonly taskService: TaskService,
    private readonly broker: BrokerOpsClient,
    private readonly workersFile: string
  ) {}

  async reconcileAll(): Promise<void> {
    for (const op of this.opsRepo.listActive()) {
      await this.reconcileOne(op.id);
    }
  }

  async reconcileOne(operationId: string): Promise<void> {
    const op = this.opsRepo.getById(operationId);
    if (!op || op.state === "SUCCEEDED" || op.state === "FAILED") return;

    log({
      event: "INFO",
      component: "worker-controller",
      message: `RECONCILE start op=${op.id} worker=${op.workerId} state=${op.state} kind=${op.kind}`,
      data: { operationId: op.id, workerId: op.workerId },
    });

    try {
      if (op.state === "PENDING") {
        this.opsRepo.update(op.id, { state: "RUNNING" });
      }

      const current = this.opsRepo.getById(op.id)!;
      const payload = { ...current.payload };

      if (current.kind === "KILL_RECREATE" && !payload.unbound) {
        await this.broker.unbind(current.workerId);
        payload.unbound = true;
        this.opsRepo.update(current.id, { payload });
      }

      if (
        (current.kind === "CREATE_CHAT" || (current.kind === "KILL_RECREATE" && payload.createMode === "create")) &&
        !payload.desiredWorkerUrl
      ) {
        const created = await this.broker.createChat(
          current.workerId,
          payload.bootstrapMessage
        );
        payload.desiredWorkerUrl = created.workerUrl;
        payload.previousWorkerUrl =
          payload.previousWorkerUrl ??
          this.taskRepo.getWorkerState(current.workerId).workerUrl ??
          "";
        this.opsRepo.update(current.id, { payload });
      }

      const refreshed = this.opsRepo.getById(op.id)!;
      await this.ensureRegistry(refreshed);
      await this.ensureDb(refreshed);
      await this.ensureBroker(refreshed);
      await this.ensureVerification(refreshed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = this.opsRepo.getById(operationId);
      if (!current) return;
      const attempt = current.attempt + 1;
      const maxAttempts = Number(
        process.env.HANDOFF_WORKER_OPS_PROBE_ATTEMPTS ?? 12
      );
      if (attempt >= maxAttempts) {
        this.opsRepo.update(operationId, {
          state: "FAILED",
          attempt,
          lastError: message,
        });
        log({
          event: "ERROR",
          component: "worker-controller",
          message: `WORKER_OP_FAILED op=${operationId} ${message}`,
          data: { operationId },
        });
      } else {
        this.opsRepo.update(operationId, {
          state: "PENDING",
          attempt,
          lastError: message,
        });
      }
    }
  }

  private getRegistryEntry(workerId: string): WorkerRegistryEntry | null {
    const topo = loadWorkersTopology({
      workersFile: this.workersFile,
      workerId,
      workerUrl: "",
      cdpEndpoint: "",
    });
    return topo.workers.find((w) => w.id === workerId) ?? null;
  }

  private async ensureRegistry(op: WorkerOperation): Promise<void> {
    const payload = op.payload;
    const desired = sanitizeChatUrl(payload.desiredWorkerUrl ?? "");
    if (!desired) {
      throw new Error("ensureRegistry: missing desiredWorkerUrl");
    }
    const existing = this.getRegistryEntry(op.workerId);
    if (!existing) {
      throw new Error(`Worker ${op.workerId} not in registry`);
    }
    if (existing.workerUrl === desired) {
      if (!payload.registryEnsured) {
        payload.registryEnsured = true;
        this.opsRepo.update(op.id, { payload });
      }
      return;
    }
    upsertWorkerRegistryEntry({
      filePath: this.workersFile,
      entry: { ...existing, workerUrl: desired },
      replace: true,
    });
    payload.registryEnsured = true;
    payload.previousWorkerUrl = payload.previousWorkerUrl ?? existing.workerUrl;
    this.opsRepo.update(op.id, { payload });
    log({
      event: "INFO",
      component: "worker-controller",
      message: `WORKER_OP_STEP registry ensured worker=${op.workerId}`,
      data: { operationId: op.id },
    });
  }

  private async ensureDb(op: WorkerOperation): Promise<void> {
    const payload = op.payload;
    if (payload.dbEnsured) return;

    const desired = sanitizeChatUrl(payload.desiredWorkerUrl ?? "");
    if (!desired) throw new Error("ensureDb: missing desiredWorkerUrl");

    const state = this.taskRepo.getWorkerState(op.workerId);
    const previous =
      payload.previousWorkerUrl ?? state.workerUrl ?? desired;

    if (state.workerUrl === desired && state.readinessReason === "CONSENT_REQUIRED") {
      payload.dbEnsured = true;
      this.opsRepo.update(op.id, { payload });
      return;
    }

    this.taskRepo.commitChatRotation({
      workerId: op.workerId,
      newWorkerUrl: desired,
      previousWorkerUrl: previous,
      readinessReason: "CONSENT_REQUIRED",
      error: "CONSENT_REQUIRED: worker-ops URL mutation",
    });
    payload.dbEnsured = true;
    this.opsRepo.update(op.id, { payload });
    log({
      event: "INFO",
      component: "worker-controller",
      message: `WORKER_OP_STEP db ensured worker=${op.workerId}`,
      data: { operationId: op.id },
    });
  }

  private async ensureBroker(op: WorkerOperation): Promise<void> {
    const payload = op.payload;
    const desired = sanitizeChatUrl(payload.desiredWorkerUrl ?? "");
    if (!desired) throw new Error("ensureBroker: missing desiredWorkerUrl");

    const status = await this.broker.status();
    const binding = status.bindings.find((b) => b.workerId === op.workerId);
    const boundOk =
      binding && chatIdFromUrl(binding.pageUrl) === chatIdFromUrl(desired);

    if (boundOk && payload.brokerEnsured) return;

    if (!boundOk) {
      await this.broker.rebind(op.workerId, desired);
    }
    payload.brokerEnsured = true;
    this.opsRepo.update(op.id, { payload });
    log({
      event: "INFO",
      component: "worker-controller",
      message: `WORKER_OP_STEP broker ensured worker=${op.workerId}`,
      data: { operationId: op.id },
    });
  }

  private async ensureVerification(op: WorkerOperation): Promise<void> {
    const payload = op.payload;
    this.opsRepo.update(op.id, { state: "VERIFYING" });

    if (!payload.probeToken) {
      payload.probeToken = probeToken();
    }
    if (!payload.probeTaskId) {
      const { taskId } = this.taskService.createSystemProbe({
        workerId: op.workerId,
        operationId: op.id,
        token: payload.probeToken,
      });
      payload.probeTaskId = taskId;
      this.opsRepo.update(op.id, { payload });
      log({
        event: "INFO",
        component: "worker-controller",
        message: `WORKER_PROBE_SCHEDULED op=${op.id} task=${taskId}`,
        data: { operationId: op.id, taskId },
      });
      return;
    }

    const task = this.taskRepo.getTaskById(payload.probeTaskId);
    if (!task) {
      throw new Error(`probe task missing: ${payload.probeTaskId}`);
    }

    const expected = `CREATE_WORKER_CANARY=${payload.probeToken}`;
    if (task.status === "COMPLETED") {
      if ((task.result ?? "").trim() !== expected) {
        throw new Error(
          `probe mismatch: got ${JSON.stringify(task.result)} want ${expected}`
        );
      }
      this.taskRepo.clearWorkerError(op.workerId);
      this.opsRepo.update(op.id, {
        state: "SUCCEEDED",
        lastError: null,
      });
      log({
        event: "INFO",
        component: "worker-controller",
        message: `WORKER_PROBE_OK op=${op.id} hash=${shortHash(payload.probeToken)}`,
        data: { operationId: op.id },
      });
      return;
    }

    if (
      task.status === "FAILED" ||
      task.status === "TIMED_OUT" ||
      task.status === "CANCELLED"
    ) {
      throw new Error(`probe ${task.status}: ${task.error ?? ""}`);
    }

    const timeoutMs = Number(process.env.CREATE_WORKER_CANARY_MS ?? 300_000);
    const createdAt = Date.parse(task.createdAt);
    if (Date.now() - createdAt > timeoutMs) {
      throw new Error(`probe timeout after ${timeoutMs}ms`);
    }

    // Still in flight — reconciler will poll again
  }
}
