import { sanitizeChatUrl } from "../dashboard/observability.js";
import { chatIdFromUrl } from "../browser/chat-url.js";
import { log } from "../logging/logger.js";
import {
  classifyProbeFailure,
  classifyCompletedProbeResult,
  probeFailureOperatorMessage,
} from "../mcp/probe-failure.js";
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

function isTerminalOpState(state: WorkerOperation["state"]): boolean {
  return state === "SUCCEEDED" || state === "FAILED";
}

function isCancelledError(message: string): boolean {
  return message.includes("worker-op cancelled");
}

function isProbePhaseFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("probe ") ||
    lower.includes("mcp_") ||
    lower.includes("probe mismatch")
  );
}

export class WorkerReconciler {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly opsRepo: WorkerOperationsRepository,
    private readonly taskRepo: TaskRepository,
    private readonly taskService: TaskService,
    private readonly broker: BrokerOpsClient,
    private readonly workersFile: string
  ) {}

  async reconcileAll(): Promise<void> {
    for (const op of this.opsRepo.listActive()) {
      const worker = this.taskRepo.findWorkerRegistryRow(op.workerId);
      if (!worker) {
        this.opsRepo.update(op.id, {
          state: "FAILED",
          lastError: "worker removed",
        });
        continue;
      }
      if (worker.error === "DISABLED") {
        this.opsRepo.update(op.id, {
          state: "FAILED",
          lastError: "worker disabled",
        });
        continue;
      }
      await this.reconcileOne(op.id);
    }
  }

  async reconcileOne(operationId: string): Promise<void> {
    const existing = this.inFlight.get(operationId);
    if (existing) return existing;

    const run = this.reconcileOneInner(operationId).finally(() => {
      this.inFlight.delete(operationId);
    });
    this.inFlight.set(operationId, run);
    return run;
  }

  private async reconcileOneInner(operationId: string): Promise<void> {
    const op = this.opsRepo.getById(operationId);
    if (!op || isTerminalOpState(op.state)) return;

    const workerRow = this.taskRepo.findWorkerRegistryRow(op.workerId);
    if (!workerRow) {
      this.opsRepo.update(operationId, {
        state: "FAILED",
        lastError: "worker removed",
      });
      return;
    }
    if (workerRow.error === "DISABLED") {
      this.opsRepo.update(operationId, {
        state: "FAILED",
        lastError: "worker disabled",
      });
      return;
    }

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

      const current = this.opsRepo.getById(op.id);
      if (!current || isTerminalOpState(current.state)) return;

      const payload = { ...current.payload };

      if (current.kind === "KILL_RECREATE" && !payload.unbound) {
        await this.broker.unbind(current.workerId);
        payload.unbound = true;
        this.opsRepo.update(current.id, { payload });
      }

      if (
        (current.kind === "CREATE_CHAT" ||
          (current.kind === "KILL_RECREATE" && payload.createMode === "create")) &&
        !payload.desiredWorkerUrl
      ) {
        const created = await this.broker.createChat(
          current.workerId,
          payload.bootstrapMessage
        );
        const afterCreate = this.opsRepo.getById(op.id);
        if (!afterCreate || isTerminalOpState(afterCreate.state)) return;
        payload.desiredWorkerUrl = created.workerUrl;
        payload.createChatAttempted = true;
        payload.previousWorkerUrl =
          payload.previousWorkerUrl ??
          this.taskRepo.findWorkerRegistryRow(current.workerId)?.workerUrl ??
          "";
        this.opsRepo.update(current.id, { payload });
      }

      const refreshed = this.opsRepo.getById(op.id);
      if (!refreshed || isTerminalOpState(refreshed.state)) return;
      await this.ensureRegistry(refreshed);
      const afterRegistry = this.opsRepo.getById(op.id);
      if (!afterRegistry || isTerminalOpState(afterRegistry.state)) return;
      await this.ensureDb(afterRegistry);
      const afterDb = this.opsRepo.getById(op.id);
      if (!afterDb || isTerminalOpState(afterDb.state)) return;
      await this.ensureBroker(afterDb);
      const afterBroker = this.opsRepo.getById(op.id);
      if (!afterBroker || isTerminalOpState(afterBroker.state)) return;
      await this.markBindingReady(afterBroker);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = this.opsRepo.getById(operationId);
      if (!current || isTerminalOpState(current.state)) return;
      if (isCancelledError(message)) return;

      if (
        current.kind === "CREATE_CHAT" ||
        (current.kind === "KILL_RECREATE" && current.payload.createMode === "create")
      ) {
        void this.broker.cancelUi(current.workerId).catch(() => undefined);
      }

      const attempt = current.attempt + 1;
      const isCreateAutomation =
        current.kind === "CREATE_CHAT" ||
        (current.kind === "KILL_RECREATE" && current.payload.createMode === "create");
      const inProbePhase =
        current.state === "VERIFYING" || Boolean(current.payload.probeTaskId);
      const defaultProbeAttempts = Number(
        process.env.HANDOFF_WORKER_OPS_PROBE_ATTEMPTS ?? 12
      );
      const maxAttempts = isCreateAutomation
        ? 1
        : inProbePhase && isProbePhaseFailure(message)
          ? 1
          : defaultProbeAttempts;
      if (attempt >= maxAttempts) {
        this.opsRepo.update(operationId, {
          state: "FAILED",
          attempt,
          lastError: message,
        });
        this.releaseWorkerAfterOpFailure(current.workerId, current.payload, message);
        log({
          event: "ERROR",
          component: "worker-controller",
          message: `WORKER_OP_FAILED op=${operationId} ${message}`,
          data: { operationId },
        });
      } else {
        const again = this.opsRepo.getById(operationId);
        if (!again || isTerminalOpState(again.state)) return;
        this.opsRepo.update(operationId, {
          state: "PENDING",
          attempt,
          lastError: message,
        });
      }
    }
  }

  private releaseWorkerAfterOpFailure(
    workerId: string,
    payload: WorkerOperationPayload,
    message: string
  ): void {
    const bindingOk =
      Boolean(payload.brokerEnsured) && Boolean(payload.dbEnsured);
    if (bindingOk && payload.probeTaskId) {
      const task = this.taskRepo.getTaskById(payload.probeTaskId);
      if (task) {
        const classified = classifyProbeFailure({
          taskStatus: task.status,
          taskError: task.error ?? message,
        });
        this.taskRepo.recordMcpWriteDegraded(
          workerId,
          `${classified}: ${probeFailureOperatorMessage(classified, task.result ?? task.error ?? message)}`
        );
        return;
      }
    }
    if (bindingOk && message.includes("probe mismatch")) {
      const task = payload.probeTaskId
        ? this.taskRepo.getTaskById(payload.probeTaskId)
        : null;
      const classified = classifyCompletedProbeResult(task?.result ?? message);
      this.taskRepo.recordMcpWriteDegraded(
        workerId,
        `${classified}: ${probeFailureOperatorMessage(classified, task?.result ?? message)}`
      );
      return;
    }
    this.taskRepo.setReadinessReason(
      workerId,
      "ROTATION_FAILED",
      `worker-op failed: ${message}`
    );
  }

  private getRegistryEntry(workerId: string): {
    id: string;
    workerUrl: string;
    cdpEndpoint: string;
  } | null {
    const row = this.taskRepo.findWorkerRegistryRow(workerId);
    if (!row?.workerUrl || !row.cdpEndpoint) return null;
    return {
      id: workerId,
      workerUrl: row.workerUrl,
      cdpEndpoint: row.cdpEndpoint,
    };
  }

  private async ensureRegistry(op: WorkerOperation): Promise<void> {
    const payload = op.payload;
    const desired = sanitizeChatUrl(payload.desiredWorkerUrl ?? "");
    if (!desired) {
      throw new Error("ensureRegistry: missing desiredWorkerUrl");
    }
    const existing = this.getRegistryEntry(op.workerId);
    if (!existing) {
      throw new Error(`Worker ${op.workerId} not in worker registry (DB)`);
    }
    if (sanitizeChatUrl(existing.workerUrl) === desired) {
      if (!payload.registryEnsured) {
        payload.registryEnsured = true;
        this.opsRepo.update(op.id, { payload });
      }
      return;
    }
    this.taskRepo.setWorkerChatUrl(op.workerId, desired);
    payload.registryEnsured = true;
    payload.previousWorkerUrl =
      payload.previousWorkerUrl ?? existing.workerUrl;
    this.opsRepo.update(op.id, { payload });
    log({
      event: "INFO",
      component: "worker-controller",
      message: `WORKER_OP_STEP registry ensured (db) worker=${op.workerId}`,
      data: { operationId: op.id },
    });
  }

  private async ensureDb(op: WorkerOperation): Promise<void> {
    const payload = op.payload;
    if (payload.dbEnsured) return;

    const desired = sanitizeChatUrl(payload.desiredWorkerUrl ?? "");
    if (!desired) throw new Error("ensureDb: missing desiredWorkerUrl");

    const state = this.taskRepo.findWorkerRegistryRow(op.workerId);
    if (!state) throw new Error(`Worker ${op.workerId} not found`);
    const previous =
      payload.previousWorkerUrl ?? state.workerUrl ?? desired;

    if (state.workerUrl === desired) {
      payload.dbEnsured = true;
      this.opsRepo.update(op.id, { payload });
      return;
    }

    this.taskRepo.commitWorkerUrlDuringOp({
      workerId: op.workerId,
      newWorkerUrl: desired,
      previousWorkerUrl: previous,
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

  private async markBindingReady(op: WorkerOperation): Promise<void> {
    const live = this.opsRepo.getById(op.id);
    if (!live || isTerminalOpState(live.state)) return;
    this.taskRepo.clearWorkerError(op.workerId);
    this.taskRepo.clearMcpWriteDegraded(op.workerId);
    this.opsRepo.update(op.id, {
      state: "SUCCEEDED",
      lastError: null,
    });
    this.scheduleConnectorHandshake(op.workerId);
    log({
      event: "INFO",
      component: "worker-controller",
      message: `WORKER_BINDING_OK op=${op.id} worker=${op.workerId} (MCP write not gated on READY)`,
      data: { operationId: op.id, workerId: op.workerId },
    });
  }

  private scheduleConnectorHandshake(workerId: string): void {
    const row = this.taskRepo.findWorkerRegistryRow(workerId);
    if (!row?.mcpWriteVerifiedAt) {
      const { taskId, skipped } = this.taskService.createConnectorHandshake({
        workerId,
      });
      if (!skipped && taskId) {
        log({
          event: "INFO",
          component: "worker-controller",
          message: `CONNECTOR_HANDSHAKE_QUEUED worker=${workerId} task=${taskId}`,
          data: { workerId, taskId },
        });
      }
    }
  }
}
