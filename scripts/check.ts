#!/usr/bin/env npx tsx
/**
 * Preflight checks for chatgpt-mcp (macOS developer preview).
 * Exit 0 only if all required checks pass.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
loadEnv({ path: join(repoRoot, ".env") });

function resolveUserPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(join(homedir(), trimmed.slice(2)));
  return resolve(trimmed);
}

type Row = { name: string; ok: boolean; detail: string };

const rows: Row[] = [];

function check(name: string, ok: boolean, detail: string): void {
  rows.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}

async function main(): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1] ?? 0);
  check(
    "node",
    major > 22 || (major === 22 && minor >= 5),
    `v${process.versions.node} (need >=22.5)`
  );

  const dist = join(repoRoot, "dist", "index.js");
  check("build", existsSync(dist), dist);

  const home = resolveUserPath(
    process.env.CHATGPT_MCP_HOME?.trim() || join(homedir(), ".chatgpt-mcp")
  );
  check(
    "home",
    existsSync(home),
    existsSync(home) ? home : `${home} missing — npm run setup`
  );

  const workerUrl = process.env.CHATGPT_WORKER_URL?.trim() ?? "";
  check(
    "CHATGPT_WORKER_URL",
    /^https?:\/\/chatgpt\.com\//i.test(workerUrl) &&
      !workerUrl.includes("REPLACE_WITH"),
    workerUrl ? "set" : "missing — edit .env"
  );

  const httpPort = Number(process.env.HANDOFF_HTTP_PORT ?? 8787);
  const cdp =
    process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222";

  try {
    const health = await fetch(`http://127.0.0.1:${httpPort}/health`);
    const body = (await health.json()) as { ok?: boolean };
    check("worker_http", health.ok && body.ok === true, `:${httpPort}/health`);
  } catch {
    check("worker_http", false, `not reachable — npm run worker`);
  }

  try {
    const worker = await fetch(`http://127.0.0.1:${httpPort}/worker`);
    const body = (await worker.json()) as {
      status?: string;
      activeTask?: boolean;
      errorCode?: string | null;
    };
    const ok =
      worker.ok &&
      (body.status === "READY" || body.status === "BUSY") &&
      !body.errorCode;
    check(
      "worker_state",
      ok,
      `status=${body.status ?? "?"} activeTask=${Boolean(body.activeTask)}`
    );
  } catch {
    check("worker_state", false, "GET /worker failed");
  }

  try {
    const cdpRes = await fetch(`${cdp.replace(/\/$/, "")}/json/version`);
    check("cdp", cdpRes.ok, cdp);
  } catch {
    check("cdp", false, `${cdp} — ./scripts/start-chrome-cdp.sh`);
  }

  const remotePort = Number(process.env.HANDOFF_REMOTE_MCP_PORT ?? 8790);
  try {
    const res = await fetch(`http://127.0.0.1:${remotePort}/mcp`, {
      method: "GET",
    });
    // Any HTTP response means something is listening (405/404/401 ok).
    check("remote_mcp", res.status > 0, `:${remotePort} status=${res.status}`);
  } catch {
    check(
      "remote_mcp",
      false,
      `:${remotePort} not up — npm run remote-mcp (needed for ChatGPT)`
    );
  }

  const failed = rows.filter((r) => !r.ok);
  console.log("");
  console.log(
    failed.length === 0
      ? "All checks passed."
      : `${failed.length} check(s) failed.`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
