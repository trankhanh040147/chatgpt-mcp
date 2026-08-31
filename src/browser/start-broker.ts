import { BrowserWorker, type BrowserWorkerOptions } from "./worker.js";
import { BrowserBroker } from "./broker.js";
import { startBrokerControlServer } from "./broker-control.js";
import { log } from "../logging/logger.js";
import { initDatabase, getDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";

export interface StartBrowserBrokerOptions {
  dbPath: string;
  cdpEndpoint: string;
  chatGptUrl: string;
  workers: Array<{ id: string; workerUrl?: string }>;
  registryWorkerIds?: string[];
  pollIntervalMs: number;
  approvalTimeoutMs: number;
  hardTimeoutMs?: number;
  rateLimitBackoffMs: number[];
  leaseMs?: number;
  workerStaleMs?: number;
  brokerOpsPort?: number;
  brokerOpsToken?: string;
}

export interface BrowserBrokerHandle {
  broker: BrowserBroker;
  workers: BrowserWorker[];
  ensureWorkerActor(workerId: string): void;
  despawnWorkerActor(workerId: string): void;
  close(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A1-S: one CDP connection, N page-bound worker actors, shared UI-write mutex.
 */
export async function startBrowserBroker(
  options: StartBrowserBrokerOptions
): Promise<BrowserBrokerHandle> {
  if (options.workers.length < 1) {
    throw new Error("startBrowserBroker requires ≥1 worker entry");
  }

  const broker = new BrowserBroker({
    cdpEndpoint: options.cdpEndpoint,
    chatGptUrl: options.chatGptUrl,
    workers: options.workers,
    registryWorkerIds: options.registryWorkerIds,
  });
  await broker.connect();

  initDatabase(options.dbPath);
  const taskRepo = new TaskRepository(getDatabase());

  const actors: BrowserWorker[] = [];
  const actorIds = new Set<string>();
  const actorById = new Map<string, BrowserWorker>();

  function onWorkerBindingRecovered(workerId: string): void {
    taskRepo.sweepStaleConsentRequired(workerId);
    taskRepo.clearWorkerRecoveryBlockers(workerId);
  }

  function notifyActorBindingChanged(workerId: string): void {
    if (!broker.hasBinding(workerId)) {
      despawnWorkerActor(workerId);
      return;
    }
    onWorkerBindingRecovered(workerId);
    const actor = actorById.get(workerId);
    if (actor) {
      actor.clearActiveTaskForBindingChange();
    } else {
      spawnActor(workerId);
    }
  }

  broker.onBindingChanged(notifyActorBindingChanged);

  function spawnActor(workerId: string): void {
    if (actorIds.has(workerId)) return;
    if (!broker.hasBinding(workerId)) {
      log({
        event: "WARN",
        component: "browser-broker",
        message: `Cannot spawn actor ${workerId} — no binding`,
      });
      return;
    }
    const binding = broker.getBinding(workerId);
    const workerOpts: BrowserWorkerOptions = {
      dbPath: options.dbPath,
      cdpEndpoint: options.cdpEndpoint,
      workerUrl: binding.workerUrl,
      chatGptUrl: options.chatGptUrl,
      pollIntervalMs: options.pollIntervalMs,
      approvalTimeoutMs: options.approvalTimeoutMs,
      hardTimeoutMs: options.hardTimeoutMs,
      rateLimitBackoffMs: options.rateLimitBackoffMs,
      workerId,
      leaseMs: options.leaseMs,
      workerStaleMs: options.workerStaleMs,
      browserOnly: true,
      resolveSharedBrowser: () => broker.getBinding(workerId).browser,
      uiWriteMutex: broker.uiWriteMutex,
      assertBindingFresh: () => {
        broker.assertBindingFresh(workerId);
      },
    };
    const worker = new BrowserWorker(workerOpts);
    actorIds.add(workerId);
    actorById.set(workerId, worker);
    actors.push(worker);
    void worker.start().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log({
        event: "ERROR",
        component: "browser-broker",
        message: `Actor ${workerId} failed fatally: ${message}`,
      });
    });
    log({
      event: "INFO",
      component: "browser-broker",
      message: `Spawned page actor ${workerId}`,
    });
  }

  function ensureWorkerActor(workerId: string): void {
    spawnActor(workerId);
  }

  function despawnWorkerActor(workerId: string): void {
    const worker = actorById.get(workerId);
    if (!worker) return;
    worker.stop();
    void worker.close().catch(() => undefined);
    actorById.delete(workerId);
    actorIds.delete(workerId);
    const idx = actors.indexOf(worker);
    if (idx >= 0) actors.splice(idx, 1);
    log({
      event: "INFO",
      component: "browser-broker",
      message: `Despawned page actor ${workerId}`,
    });
  }

  // Retry bind + actor spawn when CDP was still settling (common after make restart).
  for (const w of options.workers) {
    if (!w.workerUrl) continue;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (broker.hasBinding(w.id)) break;
      try {
        await broker.bindWorker(w.id, w.workerUrl);
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= 5) {
          log({
            event: "ERROR",
            component: "browser-broker",
            message: `Bind failed worker=${w.id} after retries: ${message}`,
          });
        } else {
          log({
            event: "WARN",
            component: "browser-broker",
            message: `Bind retry ${attempt} worker=${w.id}: ${message}`,
          });
          await sleep(1500 * attempt);
        }
      }
    }
    if (broker.hasBinding(w.id)) {
      spawnActor(w.id);
    } else {
      log({
        event: "WARN",
        component: "browser-broker",
        message: `Skipping actor ${w.id} — no binding (unbound/PENDING_URL)`,
      });
    }
  }

  await broker.reconcileBindings();
  for (const w of options.workers) {
    if (broker.hasBinding(w.id)) {
      ensureWorkerActor(w.id);
    }
  }

  const healMs = Number(process.env.HANDOFF_BROKER_HEAL_MS ?? 15_000);
  const healTimer =
    healMs > 0
      ? setInterval(() => {
          void (async () => {
            if (!broker.isHealthy()) return;
            await broker.reconcileBindings();
            for (const w of options.workers) {
              if (broker.hasBinding(w.id)) {
                ensureWorkerActor(w.id);
              }
            }
          })().catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            log({
              event: "WARN",
              component: "browser-broker",
              message: `Background heal tick failed: ${message}`,
            });
          });
        }, healMs)
      : null;

  if (options.brokerOpsPort && options.brokerOpsToken) {
    await startBrokerControlServer({
      port: options.brokerOpsPort,
      token: options.brokerOpsToken,
      broker,
      onWorkerBound: ensureWorkerActor,
      despawnWorkerActor,
    });
  }

  log({
    event: "INFO",
    component: "browser-broker",
    message: `Started ${actors.length} page actors on ${options.cdpEndpoint}`,
  });

  return {
    broker,
    workers: actors,
    ensureWorkerActor,
    despawnWorkerActor,
    async close() {
      if (healTimer) clearInterval(healTimer);
      for (const a of actors) {
        try {
          await a.close();
        } catch {
          // best-effort
        }
      }
      await broker.close();
    },
  };
}
