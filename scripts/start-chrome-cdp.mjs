#!/usr/bin/env node
/**
 * Cross-platform CDP Chrome launcher for chatgpt-mcp.
 *
 * Chrome 136+ ignores --remote-debugging-port on the default user-data-dir.
 * Always uses a dedicated profile under CHATGPT_MCP_HOME (or legacy override).
 *
 * Env:
 *   CHROME_BIN / CHATGPT_MCP_CHROME_PATH — explicit binary (wins over managed app)
 *   CHATGPT_MCP_HOME — default ~/.chatgpt-mcp
 *   CHATGPT_CDP_USER_DATA_DIR — override profile dir (legacy: ~/chrome-chatgpt-debug)
 *   CHATGPT_CDP_PORT — default 9222
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverChromeApp,
  discoverChromeExecutableDarwinFallback,
  discoverChromeExecutableLinux,
  ensureCdpChromeApp,
  hasExplicitChromeOverride,
  resolveUserPath,
  which,
} from "./lib/macos-cdp-app.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP_ICON_PATH = join(__dirname, "..", "assets", "chrome-cdp.icns");

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return existsSync(path);
  }
}

function resolveExplicitChrome() {
  const override =
    process.env.CHATGPT_MCP_CHROME_PATH?.trim() ||
    process.env.CHROME_BIN?.trim();
  const p = resolveUserPath(override);
  if (!isExecutable(p)) {
    console.error(`CHROME_BIN not executable: ${p}`);
    process.exit(1);
  }
  return p;
}

async function discoverChrome(home) {
  if (hasExplicitChromeOverride()) {
    return resolveExplicitChrome();
  }

  if (process.platform === "darwin") {
    const sourceApp = discoverChromeApp();
    if (sourceApp) {
      try {
        return await ensureCdpChromeApp({
          sourceChromeApp: sourceApp,
          home,
          iconSourcePath: CDP_ICON_PATH,
          log: (msg) => console.log(msg),
        });
      } catch (err) {
        console.warn(
          `WARN: Could not prepare Chrome CDP.app; falling back to Google Chrome.app. Dock icon will not be isolated. (${err.message})`
        );
      }
    }
    const fallback = discoverChromeExecutableDarwinFallback(isExecutable);
    if (fallback) return fallback;
  }

  if (process.platform === "linux") {
    const found = discoverChromeExecutableLinux(which, isExecutable);
    if (found) return found;
  }

  console.error(
    "Chrome/Chromium not found. Set CHROME_BIN or CHATGPT_MCP_CHROME_PATH."
  );
  process.exit(1);
}

async function cdpUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

const home = resolveUserPath(
  process.env.CHATGPT_MCP_HOME?.trim() || join(homedir(), ".chatgpt-mcp")
);
const port = Number(process.env.CHATGPT_CDP_PORT ?? 9222);

function resolveProfileDir() {
  if (process.env.CHATGPT_CDP_USER_DATA_DIR?.trim()) {
    return {
      dir: resolveUserPath(process.env.CHATGPT_CDP_USER_DATA_DIR),
      source: "CHATGPT_CDP_USER_DATA_DIR",
    };
  }
  const legacy = join(homedir(), "chrome-chatgpt-debug");
  const next = join(home, "chrome-profile");
  if (existsSync(legacy) && !existsSync(next)) {
    console.warn(
      `Using legacy profile ${legacy} (set CHATGPT_CDP_USER_DATA_DIR to pin; new default is ${next}).`
    );
    return { dir: legacy, source: "legacy~/chrome-chatgpt-debug" };
  }
  return { dir: next, source: "CHATGPT_MCP_HOME/chrome-profile" };
}

const { dir: userDataDir, source: profileSource } = resolveProfileDir();
const chrome = await discoverChrome(home);

if (await cdpUp(port)) {
  console.log(`CDP already listening on :${port} — not starting another Chrome.`);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/json/version`)).text();
    console.log(body);
  } catch {
    /* ignore */
  }
  console.log("Log into ChatGPT in that dedicated CDP window.");
  try {
    const health = await fetch("http://127.0.0.1:8787/health");
    if (health.ok) {
      console.log("Worker already running on :8787 — do NOT run npm run worker again.");
    } else {
      console.log("Then: npm run worker");
    }
  } catch {
    console.log("Then: npm run worker");
  }
  process.exit(0);
}

if (process.platform === "linux") {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error(
      "NO_DESKTOP_SESSION: Linux needs DISPLAY or WAYLAND_DISPLAY for interactive ChatGPT login."
    );
    process.exit(1);
  }
}

mkdirSync(userDataDir, { recursive: true });
console.log(`Starting Chrome CDP on :${port}`);
console.log(`  binary=${chrome}`);
console.log(`  user-data-dir=${userDataDir} (${profileSource})`);
console.log("Sign into ChatGPT in this window (not your daily Default profile).");

const child = spawn(
  chrome,
  [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://chatgpt.com",
  ],
  {
    detached: true,
    stdio: "ignore",
  }
);
child.unref();
console.log(`spawned pid=${child.pid}`);

const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  if (await cdpUp(port)) {
    console.log(`CDP ready on :${port}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.error(`CDP_UNREACHABLE: Chrome started but :${port}/json/version not ready`);
process.exit(1);
