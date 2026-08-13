#!/usr/bin/env node
/**
 * Cross-platform CDP Chrome launcher for chatgpt-mcp.
 *
 * Chrome 136+ ignores --remote-debugging-port on the default user-data-dir.
 * Always uses a dedicated profile under CHATGPT_MCP_HOME (or legacy override).
 *
 * Env:
 *   CHROME_BIN / CHATGPT_MCP_CHROME_PATH — explicit binary
 *   CHATGPT_MCP_HOME — default ~/.chatgpt-mcp
 *   CHATGPT_CDP_USER_DATA_DIR — override profile dir (legacy: ~/chrome-chatgpt-debug)
 *   CHATGPT_CDP_PORT — default 9222
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function resolveUserPath(raw) {
  const trimmed = String(raw).trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(join(homedir(), trimmed.slice(2)));
  return resolve(trimmed);
}

function which(cmd) {
  try {
    const out = execFileSync(
      process.platform === "win32" ? "where" : "which",
      [cmd],
      { encoding: "utf8" }
    )
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return existsSync(path);
  }
}

function discoverChrome() {
  const override =
    process.env.CHATGPT_MCP_CHROME_PATH?.trim() ||
    process.env.CHROME_BIN?.trim();
  if (override) {
    const p = resolveUserPath(override);
    if (!isExecutable(p)) {
      console.error(`CHROME_BIN not executable: ${p}`);
      process.exit(1);
    }
    return p;
  }

  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(
        homedir(),
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      ),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for (const c of candidates) {
      if (isExecutable(c)) return c;
    }
  }

  if (process.platform === "linux") {
    const names = [
      "google-chrome-stable",
      "google-chrome",
      "chromium",
      "chromium-browser",
    ];
    for (const name of names) {
      const found = which(name);
      if (found) return found;
    }
    const paths = [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ];
    for (const p of paths) {
      if (isExecutable(p)) return p;
    }
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
const chrome = discoverChrome();

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