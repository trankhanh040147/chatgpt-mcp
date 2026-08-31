import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { BrowserBroker } from "./broker.js";
import { log } from "../logging/logger.js";

const BODY_MAX = 16_384;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => {
      chunks.push(Buffer.from(c));
      if (chunks.reduce((n, b) => n + b.length, 0) > BODY_MAX) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function parseBearer(req: IncomingMessage): string | null {
  const hdr = req.headers.authorization;
  if (!hdr?.startsWith("Bearer ")) return null;
  return hdr.slice(7).trim();
}

export interface StartBrokerControlServerOptions {
  port: number;
  token: string;
  broker: BrowserBroker;
  /** Spawn claim-loop actor after bind/rebind (recovery when startup bind raced CDP). */
  onWorkerBound?: (workerId: string) => void;
  /** Stop page actor after fleet remove / unbind without restart. */
  despawnWorkerActor?: (workerId: string) => void;
}

export function startBrokerControlServer(
  options: StartBrokerControlServerOptions
): Promise<void> {
  if (!options.token) {
    throw new Error(
      "HANDOFF_BROKER_OPS_TOKEN is required when broker control server is enabled"
    );
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const token = parseBearer(req);
        if (!token || token !== options.token) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.method === "GET" && url.pathname === "/broker/status") {
          sendJson(res, 200, options.broker.getStatusSnapshot());
          return;
        }

        if (req.method === "POST" && url.pathname === "/broker/reconcile") {
          await options.broker.reconcileBindings();
          sendJson(res, 200, { ok: true, ...options.broker.getStatusSnapshot() });
          return;
        }

        if (req.method === "GET" && url.pathname === "/broker/probe-session") {
          const workerId = url.searchParams.get("workerId")?.trim() ?? "";
          if (!workerId) {
            sendJson(res, 400, { error: "workerId required" });
            return;
          }
          const result = await options.broker.probeSession(workerId);
          sendJson(res, 200, result);
          return;
        }

        if (req.method === "POST") {
          const raw = await readBody(req);
          const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          const workerId = String(body.workerId ?? "").trim();

          if (url.pathname === "/broker/rebind") {
            const workerUrl = String(body.workerUrl ?? "").trim();
            if (!workerId || !workerUrl) {
              sendJson(res, 400, { error: "workerId and workerUrl required" });
              return;
            }
            await options.broker.rebindWorker(workerId, workerUrl);
            options.onWorkerBound?.(workerId);
            sendJson(res, 200, { ok: true });
            return;
          }

          if (url.pathname === "/broker/unbind") {
            if (!workerId) {
              sendJson(res, 400, { error: "workerId required" });
              return;
            }
            options.broker.cancelWorkerUi(workerId);
            await options.broker.unbindWorker(workerId);
            sendJson(res, 200, { ok: true });
            return;
          }

          if (url.pathname === "/broker/cancel-ui") {
            if (!workerId) {
              sendJson(res, 400, { error: "workerId required" });
              return;
            }
            options.broker.cancelWorkerUi(workerId);
            sendJson(res, 200, { ok: true });
            return;
          }

          if (url.pathname === "/broker/despawn-actor") {
            if (!workerId) {
              sendJson(res, 400, { error: "workerId required" });
              return;
            }
            options.despawnWorkerActor?.(workerId);
            sendJson(res, 200, { ok: true });
            return;
          }

          if (url.pathname === "/broker/create-chat") {
            if (!workerId) {
              sendJson(res, 400, { error: "workerId required" });
              return;
            }
            const bootstrapMessage =
              typeof body.bootstrapMessage === "string"
                ? body.bootstrapMessage
                : undefined;
            const created = await options.broker.createChatForWorker(
              workerId,
              bootstrapMessage
            );
            options.onWorkerBound?.(workerId);
            sendJson(res, 200, created);
            return;
          }
        }

        sendJson(res, 404, { error: "not found" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log({
          event: "ERROR",
          component: "browser-broker",
          message: `broker-control error: ${message}`,
        });
        sendJson(res, 500, { error: message });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      log({
        event: "INFO",
        component: "browser-broker",
        message: `Broker control listening on http://127.0.0.1:${options.port}`,
      });
      resolve();
    });
  });
}
