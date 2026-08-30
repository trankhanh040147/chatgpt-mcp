import { createHash, randomBytes } from "node:crypto";
import type { WorkerRegistryEntry } from "../config/workers-topology.js";
import { loadWorkersTopology } from "../config/workers-topology.js";
import { upsertWorkerRegistryEntry } from "../config/write-workers-topology.js";
import { sanitizeChatUrl } from "../dashboard/observability.js";
import { chatIdFromUrl } from "../browser/chat-url.js";
import { log } from "../logging/logger.js";
import {
  classifyProbeFailure,
  probeFailureOperatorMessage,
  probeFailureToReadiness,
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

function probeToken(): string {
  return randomBytes(16).toString("hex");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function probeCanaryMatches(result: string, token: string): boolean {
  const trimmed = result.trim();
  const expected = `CREATE_WORKER_CANARY=${token}`;
  if (trimmed === expected) return true;
  // ChatGPT often wraps the canary in prose; token must still appear verbatim.
  return new RegExp(`CREATE_WORKER_CANARY=${token}(?:\\b|[^a-zA-Z0-9])`).test(
    trimmed
  );
}

function isTerminalOpState(state: WorkerOperation["state"]): boolean {
  return state === "SUCCEEDED" || state === "FAILED";
}

function isCancelledError(message: string): boolean {
  return message.includes("worker-op cancelled");
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
      const worker = this.taskRepo.getWorkerState(op.workerId);
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

    const workerState = this.taskRepo.getWorkerState(op.workerId);
    if (workerState.error === "DISABLED") {
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
        if (payload.createChatAttempted) {
          throw new Error(
            current.lastError ??
              "create-chat already failed — cancel op, use Assign URL with an existing /c/ chat, or attach Cursor manually in CDP Chrome"
          );
        }
        payload.createChatAttempted = true;
        this.opsRepo.update(current.id, { payload });
        const created = await this.broker.createChat(
          current.workerId,
          payload.bootstrapMessage
        );
        const afterCreate = this.opsRepo.getById(op.id);
        if (!afterCreate || isTerminalOpState(afterCreate.state)) return;
        payload.desiredWorkerUrl = created.workerUrl;
        payload.previousWorkerUrl =
          payload.previousWorkerUrl ??
          this.taskRepo.getWorkerState(current.workerId).workerUrl ??
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
      await this.ensureVerification(afterBroker);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = this.opsRepo.getById(operationId);
      if (!current || isTerminalOpState(current.state)) return;
      if (isCancelledError(message)) return;

      const attempt = current.attempt + 1;
      const isCreateAutomation =
        current.kind === "CREATE_CHAT" ||
        (current.kind === "KILL_RECREATE" && current.payload.createMode === "create");
      const maxAttempts = isCreateAutomation
        ? 1
        : Number(process.env.HANDOFF_WORKER_OPS_PROBE_ATTEMPTS ?? 12);
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
        const readiness = probeFailureToReadiness(classified);
        this.taskRepo.setReadinessReason(
          workerId,
          readiness,
          probeFailureOperatorMessage(classified)
        );
        return;
      }
    }
    if (bindingOk && message.includes("probe mismatch")) {
      this.taskRepo.setReadinessReason(
        workerId,
        "PROBE_RESULT_MISMATCH",
        probeFailureOperatorMessage("PROBE_RESULT_MISMATCH")
      );
      return;
    }
    this.taskRepo.setReadinessReason(
      workerId,
      "ROTATION_FAILED",
      `worker-op failed: ${message}`
    );
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
      if (!probeCanaryMatches(task.result ?? "", payload.probeToken!)) {
        throw new Error(
          `probe mismatch: got ${JSON.stringify(task.result)} want ${expected}`
        );
      }
      const live = this.opsRepo.getById(op.id);
      if (!live || isTerminalOpState(live.state)) return;
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
