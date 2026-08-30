import { readFileSync, existsSync } from "node:fs";
import { chatgptMcpHome, resolveUserPath } from "../config/load-config.js";
import { join } from "node:path";
import { resolveBrokerOpsPort } from "./broker-ops-config.js";
import { log } from "../logging/logger.js";

export interface BrokerBindingSnapshot {
  workerId: string;
  chatId: string;
  pageUrl: string;
  generation: number;
}

export interface BrokerStatusSnapshot {
  healthy: boolean;
  cdpEndpoint: string;
  connectionGeneration: number;
  bindings: BrokerBindingSnapshot[];
}

export class BrokerOpsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    if (!res.ok) {
      const msg =
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof (parsed as { error: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : `broker ops ${method} ${path} → ${res.status}`;
      throw new Error(msg);
    }
    return parsed as T;
  }

  async status(): Promise<BrokerStatusSnapshot> {
    return this.request<BrokerStatusSnapshot>("GET", "/broker/status");
  }

  async probeSession(workerId: string): Promise<{ ready: boolean; reason?: string }> {
    return this.request("GET", `/broker/probe-session?workerId=${encodeURIComponent(workerId)}`);
  }

  async rebind(workerId: string, workerUrl: string): Promise<void> {
    await this.request("POST", "/broker/rebind", { workerId, workerUrl });
  }

  async unbind(workerId: string): Promise<void> {
    await this.request("POST", "/broker/unbind", { workerId });
  }

  async cancelUi(workerId: string): Promise<void> {
    await this.request("POST", "/broker/cancel-ui", { workerId });
  }

  async createChat(
    workerId: string,
    bootstrapMessage?: string
  ): Promise<{ workerUrl: string; chatId: string }> {
    return this.request("POST", "/broker/create-chat", {
      workerId,
      bootstrapMessage,
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.status();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log({
        event: "WARN",
        component: "worker-controller",
        message: `broker ping failed: ${message}`,
      });
      return false;
    }
  }
}

export function resolveBrokerOpsToken(): string {
  const fromEnv = process.env.HANDOFF_BROKER_OPS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const logDir = resolveUserPath(process.env.LOG_DIR?.trim() || join(chatgptMcpHome(), "logs"));
  const tokenPath = join(logDir, "broker-ops.token");
  if (existsSync(tokenPath)) {
    try {
      return readFileSync(tokenPath, "utf-8").trim();
    } catch {
      /* ignore */
    }
  }
  return "";
}

export function brokerOpsClientFromEnv(): BrokerOpsClient | null {
  const port = resolveBrokerOpsPort();
  const token = resolveBrokerOpsToken();
  if (!token) return null;
  return new BrokerOpsClient(`http://127.0.0.1:${port}`, token);
}
