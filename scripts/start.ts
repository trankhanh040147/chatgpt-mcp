#!/usr/bin/env npx tsx
/**
 * Bring up the local handoff stack for a happy-path session:
 *   1) dedicated CDP Chrome (idempotent)
 *   2) remote MCP (:8790) + worker (:8787) in the foreground
 *
 * Ctrl+C stops remote-mcp and worker (Chrome stays up).
 * Prefer Secure MCP Tunnel for ChatGPT — see docs/connect-chatgpt.md.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = process.cwd();
loadEnv({ path: join(repoRoot, ".env") });

const children: ChildProcess[] = [];
let shuttingDown = false;

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

async function cdpReady(): Promise<boolean> {
  const cdp =
    process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222";
  try {
    const res = await fetch(`${cdp.replace(/\/$/, "")}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnNode(
  label: string,
  args: string[],
  extraEnv?: Record<string, string>
): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `[start] ${label} exited code=${code ?? "?"} signal=${signal ?? "-"}`
      );
      void shutdown(code && code !== 0 ? code : 1);
    }
  });
  children.push(child);
  return child;
}

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  // Give children a moment; then force-exit.
  setTimeout(() => process.exit(code), 1500).unref();
}

async function main(): Promise<void> {
  const dist = join(repoRoot, "dist", "index.js");
  if (!existsSync(dist)) {
    console.error("dist/ missing — run: npm run build");
    process.exit(1);
  }

  if (!(await cdpReady())) {
    console.log("[start] Starting dedicated CDP Chrome…");
    const chrome = spawn(process.execPath, ["scripts/start-chrome-cdp.mjs"], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
      detached: true,
    });
    chrome.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await cdpReady()) break;
    }
    if (!(await cdpReady())) {
      console.error(
        "[start] CDP not ready — run ./scripts/start-chrome-cdp.sh and log into ChatGPT in that window."
      );
      process.exit(1);
    }
  } else {
    console.log("[start] CDP already listening.");
  }

  const httpPort = Number(process.env.HANDOFF_HTTP_PORT ?? 8787);
  const remotePort = Number(process.env.HANDOFF_REMOTE_MCP_PORT ?? 8790);

  if (await portInUse(httpPort)) {
    console.error(
      `[start] Port :${httpPort} already in use — stop the existing worker (or use it) before npm run start.`
    );
    process.exit(1);
  }
  if (await portInUse(remotePort)) {
    console.error(
      `[start] Port :${remotePort} already in use — stop the existing remote-mcp before npm run start.`
    );
    process.exit(1);
  }

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  console.log("[start] remote-mcp :" + remotePort);
  spawnNode("remote-mcp", [dist, "remote-mcp"]);

  console.log("[start] worker :" + httpPort);
  spawnNode("worker", [dist, "worker"]);

  console.log("");
  console.log("Stack up. In another terminal: npm run check");
  console.log("Connect ChatGPT via Secure MCP Tunnel — docs/connect-chatgpt.md");
  console.log("Ctrl+C stops remote-mcp + worker (Chrome stays open).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
