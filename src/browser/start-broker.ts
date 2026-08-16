import { BrowserWorker, type BrowserWorkerOptions } from "./worker.js";
import { BrowserBroker } from "./broker.js";
import { log } from "../logging/logger.js";

export interface StartBrowserBrokerOptions {
  dbPath: string;
  cdpEndpoint: string;
  chatGptUrl: string;
  workers: Array<{ id: string; workerUrl: string }>;
  pollIntervalMs: number;
  approvalTimeoutMs: number;
  hardTimeoutMs?: number;
  rateLimitBackoffMs: number[];
  leaseMs?: number;
  workerStaleMs?: number;
}

export interface BrowserBrokerHandle {
  broker: BrowserBroker;
  workers: BrowserWorker[];
  close(): Promise<void>;
}

/**
 * A1-S: one CDP connection, N page-bound worker actors, shared UI-write mutex.
 */
export async function startBrowserBroker(
  options: StartBrowserBrokerOptions
): Promise<BrowserBrokerHandle> {
  if (options.workers.length < 1) {
    throw new Error("startBrowserBroker requires ≥1 worker");
  }

  const broker = new BrowserBroker({
    cdpEndpoint: options.cdpEndpoint,
    chatGptUrl: options.chatGptUrl,
    workers: options.workers,
  });
  await broker.connect();

  const actors: BrowserWorker[] = [];
  for (const w of options.workers) {
    const workerOpts: BrowserWorkerOptions = {
      dbPath: options.dbPath,
      cdpEndpoint: options.cdpEndpoint,
      workerUrl: w.workerUrl,
      chatGptUrl: options.chatGptUrl,
      pollIntervalMs: options.pollIntervalMs,
      approvalTimeoutMs: options.approvalTimeoutMs,
      hardTimeoutMs: options.hardTimeoutMs,
      rateLimitBackoffMs: options.rateLimitBackoffMs,
      workerId: w.id,
      leaseMs: options.leaseMs,
      workerStaleMs: options.workerStaleMs,
      browserOnly: true,
      resolveSharedBrowser: () => broker.getBinding(w.id).browser,
      uiWriteMutex: broker.uiWriteMutex,
      assertBindingFresh: () => {
        broker.assertBindingFresh(w.id);
      },
    };
    const worker = new BrowserWorker(workerOpts);
    void worker.start().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log({
        event: "ERROR",
        component: "browser-broker",
        message: `Actor ${w.id} failed fatally: ${message}`,
      });
    });
    actors.push(worker);
  }

  log({
    event: "INFO",
    component: "browser-broker",
    message: `Started ${actors.length} page actors on ${options.cdpEndpoint}`,
  });

  return {
    broker,
    workers: actors,
    async close() {
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
