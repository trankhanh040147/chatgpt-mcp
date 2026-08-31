import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  resolveWorkersFilePath,
  type AppConfig,
} from "../config/load-config.js";
import { resolveBrokerOpsPort } from "../ops/broker-ops-config.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Repo root (works from src/ during tsx and from dist/ after build). */
export function repoRoot(): string {
  const fromDist = resolve(moduleDir, "../..");
  if (existsSync(join(fromDist, "package.json"))) return fromDist;
  const fromSrc = resolve(moduleDir, "../..");
  return fromSrc;
}

// Load this package's project config, never an unrelated caller cwd/.env.
loadEnv({ path: join(repoRoot(), ".env"), quiet: true });

export function loadCliConfig(): AppConfig {
  return loadConfig();
}

export function statusBaseUrl(config: AppConfig): string {
  return `http://127.0.0.1:${config.httpPort}`;
}

export function dashboardUrl(config: AppConfig): string {
  return `${statusBaseUrl(config)}/dashboard/`;
}

export function remoteMcpUrl(config: AppConfig): string {
  return `http://127.0.0.1:${config.remoteMcpPort}/mcp`;
}

export function brokerOpsPort(): number {
  return resolveBrokerOpsPort();
}

export function workersFilePath(config: AppConfig): string {
  return resolveWorkersFilePath(config.workersFile);
}

export function logFilePath(config: AppConfig): string {
  return join(config.logDir, "handoff.log");
}
