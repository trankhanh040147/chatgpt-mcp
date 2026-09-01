#!/usr/bin/env npx tsx
/**
 * 40-file (configurable) native attach observability E2E.
 *
 * Separates: worker upload count, DOM chip visibility, model canary readability.
 *
 *   npm run e2e:attach-observability
 *   npm run e2e:attach-observability -- --count=40
 *   npm run e2e:attach-observability -- --count=10 --skip-model
 *
 * Prerequisites: broker stack, CDP Chrome logged in, HANDOFF_DB_PATH aligned.
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { initDatabase, getDatabase } from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";
import type { HandoffTaskStatus } from "../src/tasks/task.types.js";
import {
  computeUploadWaitMs,
} from "../src/browser/composer-attach.js";
import {
  CHATGPT_DOM_CHIP_CAP,
  verifyAddedChipsMatchExpected,
} from "../src/browser/attachment-match.js";
import { chatIdFromUrl } from "../src/browser/chat-url.js";
import { brokerOpsClientFromEnv } from "../src/ops/broker-client.js";

loadEnv({ path: resolve(process.cwd(), ".env") });

const WS_DIR = ".e2e-attach-obs-ws";
const LOG_DIR = process.env.LOG_DIR ?? join(process.cwd(), "logs");

function resolveUserPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(join(homedir(), trimmed.slice(2)));
  return resolve(trimmed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function markerForIndex(i: number): string {
  return `ATTACH_${pad2(i)}`;
}

function filenameForIndex(i: number, runTag: string): string {
  return `attach-obs-${runTag}-${pad2(i)}.txt`;
}

interface Args {
  count: number;
  skipModel: boolean;
  freshChat: boolean;
  timeoutMs: number;
  pollMs: number;
}

function parseArgs(argv: string[]): Args {
  let count = Number(process.env.E2E_ATTACH_OBS_COUNT ?? 40);
  let skipModel = false;
  let freshChat = true;
  let timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 480_000);
  let pollMs = Number(process.env.E2E_POLL_MS ?? 1500);
  for (const arg of argv) {
    if (arg.startsWith("--count=")) count = Number(arg.slice(8));
    else if (arg === "--skip-model") skipModel = true;
    else if (arg === "--no-fresh-chat") freshChat = false;
    else if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = Math.max(5_000, Number(arg.slice(13)));
    } else if (arg.startsWith("--poll-ms=")) {
      pollMs = Math.max(200, Number(arg.slice(10)));
    }
  }
  if (!Number.isFinite(count) || count < 2 || count > 100) {
    throw new Error("--count must be 2..100");
  }
  return { count, skipModel, timeoutMs, pollMs };
}

async function httpJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function preflight(httpBase: string, cdpEndpoint: string): Promise<void> {
  const health = await httpJson<{ ok?: boolean }>(`${httpBase}/health`);
  if (!health.ok) throw new Error("HTTP /health not ok");
  const cdp = await fetch(`${cdpEndpoint.replace(/\/$/, "")}/json/version`);
  if (!cdp.ok) throw new Error(`CDP not reachable at ${cdpEndpoint}`);
}

function createMarkerWorkspace(count: number, wsRoot: string, runTag: string): string[] {
  rmSync(wsRoot, { recursive: true, force: true });
  mkdirSync(wsRoot, { recursive: true });
  const paths: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const name = filenameForIndex(i, runTag);
    writeFileSync(
      join(wsRoot, name),
      `${markerForIndex(i)}\nobservability-canary-${runTag}-${i}\n`
    );
    paths.push(name);
  }
  return paths;
}

function buildPrompt(
  count: number,
  canaryA: number,
  canaryB: number,
  runTag: string
): string {
  const mA = markerForIndex(canaryA);
  const mB = markerForIndex(canaryB);
  const canaryFileA = filenameForIndex(canaryA, runTag);
  const canaryFileB = filenameForIndex(canaryB, runTag);
  return [
    "Native attach observability E2E — read attached file content only.",
    "Do NOT call handoff_read_file.",
    "",
    "Return exactly these lines in handoff_submit_result:",
    `CANARY_${pad2(canaryA)}=<exact marker text from ${canaryFileA}, or UNREADABLE>`,
    `CANARY_${pad2(canaryB)}=<exact marker text from ${canaryFileB}, or UNREADABLE>`,
    `CHIP_COUNT=<number of attachment chips visible in composer>`,
    `READABLE_COUNT=<how many attached files you could read content from, of ${count}>`,
    "",
    `Expected markers look like: ${markerForIndex(1)}, ${markerForIndex(2)}, … ${markerForIndex(count)}`,
  ].join("\n");
}

async function waitWorkerReady(httpBase: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const worker = await httpJson<{ status?: string; activeTask?: unknown }>(
      `${httpBase}/worker`
    );
    if (worker.status === "READY" && !worker.activeTask) return;
    await sleep(500);
  }
  throw new Error("Timed out waiting for worker READY");
}

async function ensureFreshChat(
  repo: TaskRepository,
  httpBase: string
): Promise<void> {
  const broker = brokerOpsClientFromEnv();
  if (!broker) {
    console.warn("WARN: broker ops unavailable — skipping fresh chat");
    return;
  }
  const workerId = "w4";
  await waitWorkerReady(httpBase, 60_000);
  const created = await broker.createChat(workerId, "OK");
  repo.setWorkerChatUrl(workerId, created.workerUrl);
  console.log(`fresh chat worker=${workerId} chatId=${created.chatId}`);
  await waitWorkerReady(httpBase, 60_000);
}

async function waitForStatus(
  httpBase: string,
  taskId: string,
  want: HandoffTaskStatus[],
  timeoutMs: number,
  pollMs: number
): Promise<HandoffTaskStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status } = await httpJson<{ status: HandoffTaskStatus }>(
      `${httpBase}/tasks/${encodeURIComponent(taskId)}`
    );
    if (want.includes(status)) return status;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for ${want.join("|")} (task ${taskId})`);
}

function parseHandoffLogEvents(taskId: string): Record<string, string> {
  const logPath = join(LOG_DIR, "handoff.log");
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.includes(taskId)) continue;
    try {
      const row = JSON.parse(line) as {
        event?: string;
        message?: string;
        timestamp?: string;
      };
      if (row.event === "RESOURCE_ATTACHED" && row.message) {
        out.attached = row.message;
      }
      if (row.event === "RESOURCE_VERIFIED" && row.message) {
        out.verified = row.message;
      }
      if (row.event === "TASK_DISPATCHED") {
        out.dispatchedAt = row.timestamp ?? "";
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** Detect ChatGPT account upload quota banner (observed 2026-09). */
async function scanUploadQuotaBanner(page: Page): Promise<{
  hit: boolean;
  text: string | null;
  resetsAt: string | null;
}> {
  return page.evaluate(() => {
    const bodyText = document.body.innerText ?? "";
    const m = bodyText.match(
      /added all your available file uploads until ([0-9]{1,2}:[0-9]{2}\s*[AP]M)/i
    );
    if (!m) return { hit: false, text: null, resetsAt: null };
    const line =
      bodyText
        .split("\n")
        .find((l) => /added all your available file uploads/i.test(l))
        ?.trim() ?? m[0];
    return { hit: true, text: line, resetsAt: m[1] ?? null };
  });
}

/** Broader DOM scan than readAttachmentChips — diagnostic only. */
async function scanRawAttachmentDom(page: Page): Promise<{
  removeButtonCount: number;
  removeLabels: string[];
  attachmentNodeCount: number;
  attachmentTexts: string[];
}> {
  return page.evaluate(() => {
    const removeLabels: string[] = [];
    for (const btn of document.querySelectorAll("button[aria-label]")) {
      const label = btn.getAttribute("aria-label") ?? "";
      if (/^Remove\s+/i.test(label)) removeLabels.push(label);
    }
    const composer =
      document.querySelector("#prompt-textarea")?.closest("form") ??
      document.querySelector("main form") ??
      document.body;
    const attachmentTexts: string[] = [];
    for (const el of composer.querySelectorAll(
      '[data-testid*="file"], [data-testid*="attachment"], [class*="attachment"]'
    )) {
      const t = (el.textContent ?? "").trim();
      if (t && t.length <= 120) attachmentTexts.push(t.split("\n")[0]!.trim());
    }
    return {
      removeButtonCount: removeLabels.length,
      removeLabels,
      attachmentNodeCount: attachmentTexts.length,
      attachmentTexts,
    };
  });
}

async function findPageForWorkerUrl(
  pages: Page[],
  workerUrl: string
): Promise<Page | null> {
  const wantId = chatIdFromUrl(workerUrl);
  if (!wantId) return null;
  for (const page of pages) {
    if (page.isClosed()) continue;
    const url = page.url();
    if (chatIdFromUrl(url) === wantId) return page;
  }
  return null;
}

function chipsFromRawDom(raw: {
  removeLabels: string[];
  attachmentTexts: string[];
}): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (rawName: string) => {
    const t = rawName.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    names.push(t);
  };
  for (const label of raw.removeLabels) {
    const m = label.match(/^Remove\s+(?:file\s+\d+:\s*)?(.+?)(?:\s+file)?$/i);
    if (m?.[1]) push(m[1]);
  }
  for (const text of raw.attachmentTexts) {
    push(text);
  }
  return names;
}

async function captureDomDiagnostics(
  cdpEndpoint: string,
  workerUrl: string | undefined,
  expectedNames: string[]
): Promise<Record<string, unknown> | null> {
  if (!workerUrl) return null;
  const browser = await chromium.connectOverCDP(cdpEndpoint, { noDefaults: true });
  try {
    const context = browser.contexts()[0];
    if (!context) return { error: "no_browser_context" };
    const page = await findPageForWorkerUrl(context.pages(), workerUrl);
    if (!page) return { error: "worker_page_not_found", workerUrl };
    const raw = await scanRawAttachmentDom(page);
    const quota = await scanUploadQuotaBanner(page);
    const chips = chipsFromRawDom(raw);
    const verify = verifyAddedChipsMatchExpected([], chips, expectedNames);
    return {
      pageUrl: page.url(),
      uploadQuota: quota,
      readAttachmentChips: chips,
      chipCount: chips.length,
      rawDom: raw,
      verifyMode: verify.ok ? verify.mode : "unverified",
      verifyOk: verify.ok,
      uploadWaitMsBudget: computeUploadWaitMs(expectedNames.length || 40),
    };
  } finally {
    // Never browser.close() on shared CDP — that kills the worker's Chrome session.
  }
}

function interpretReport(report: Record<string, unknown>): string {
  const fileCount = report.fileCount as number;
  const domDiagnostic = report.domDiagnostic as {
    chipCount?: number;
    uploadQuota?: { hit?: boolean; resetsAt?: string | null };
  } | null;
  const domChipCount = domDiagnostic?.chipCount;
  const quota = domDiagnostic?.uploadQuota;
  const verified = report.logEvents as { verified?: string } | undefined;
  const result = (report.modelResult as string) ?? "";
  const hasLateCanary =
    result.includes("ATTACH_21") || result.includes("CANARY_21=ATTACH_21");
  const has40Canary =
    result.includes("ATTACH_40") || result.includes("CANARY_40=ATTACH_40");

  if (quota?.hit) {
    const until = quota.resetsAt ? ` until ${quota.resetsAt}` : "";
    return `UPLOAD_QUOTA_EXCEEDED: ChatGPT account upload limit${until} — not a worker/DOM-cap bug`;
  }

  if (domChipCount != null && domChipCount >= Math.min(fileCount, CHATGPT_DOM_CHIP_CAP)) {
    if (fileCount > CHATGPT_DOM_CHIP_CAP && !hasLateCanary) {
      return "DOM_CAP_LIKELY: upload ok, ~20 chips visible, late markers unreadable by model";
    }
    if (hasLateCanary && has40Canary) {
      return "FULL_SUCCESS: model read late-position markers";
    }
    if (fileCount <= CHATGPT_DOM_CHIP_CAP) {
      return "SMALL_BATCH_OK";
    }
  }
  if (
    verified?.verified?.includes("CHIP_MISMATCH") ||
    (report.taskError as string | null)?.includes("CHIP_MISMATCH")
  ) {
    if ((domChipCount ?? 0) >= Math.min(fileCount, CHATGPT_DOM_CHIP_CAP)) {
      return "WORKER_CHIP_MISMATCH: attach ok, subset visible, worker verify failed";
    }
    return "CHIP_MISMATCH";
  }
  return "INCONCLUSIVE — inspect report JSON";
}

async function main(): Promise<void> {
  const { count, skipModel, freshChat, timeoutMs, pollMs } = parseArgs(
    process.argv.slice(2)
  );
  const dbPath = resolveUserPath(process.env.HANDOFF_DB_PATH ?? "./data/handoff.sqlite");
  const httpPort = Number(process.env.HANDOFF_HTTP_PORT ?? 8787);
  const httpBase = `http://127.0.0.1:${httpPort}`;
  const cdpEndpoint =
    process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222";

  const runTag = Date.now().toString(36);
  const wsRoot = resolve(process.cwd(), WS_DIR);
  process.env.HANDOFF_WORKSPACE_ROOT = wsRoot;
  const files = createMarkerWorkspace(count, wsRoot, runTag);

  const canaryA = Math.min(21, count);
  const canaryB = count;

  initDatabase(dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);

  console.log(`E2E attach-observability count=${count} runTag=${runTag} canaries=${canaryA},${canaryB}`);
  await preflight(httpBase, cdpEndpoint);
  if (freshChat) {
    await ensureFreshChat(repo, httpBase);
  }

  const conversationId = `e2e-attach-obs-${Date.now()}`;
  const { taskId } = taskService.createTask({
    type: "second_opinion",
    prompt: buildPrompt(count, canaryA, canaryB, runTag),
    cursorConversationId: conversationId,
    files,
  });
  console.log(`created taskId=${taskId} files=${files.length}`);

  let domDiagnostic: Record<string, unknown> | null = null;
  let attachSeenAt: number | null = null;
  const expectedNames = files.map((f) => f.split("/").pop() ?? f);

  const deadline = Date.now() + timeoutMs;
  let finalStatus: HandoffTaskStatus | null = null;
  while (Date.now() < deadline) {
    const { status } = await httpJson<{ status: HandoffTaskStatus }>(
      `${httpBase}/tasks/${encodeURIComponent(taskId)}`
    );

    const events = parseHandoffLogEvents(taskId);
    if (events.attached && attachSeenAt === null) {
      attachSeenAt = Date.now();
      console.log("RESOURCE_ATTACHED seen — scheduling mid-verify DOM scan");
    }
    if (
      attachSeenAt !== null &&
      domDiagnostic === null &&
      Date.now() - attachSeenAt >= 35_000
    ) {
      const scanTask = repo.getTaskById(taskId);
      const workerId = scanTask?.leaseOwner ?? "default";
      const worker = repo.getWorkerState(workerId);
      console.log(
        `mid-verify DOM scan worker=${workerId} url=${worker.workerUrl ?? "?"}`
      );
      domDiagnostic = await captureDomDiagnostics(
        cdpEndpoint,
        worker.workerUrl,
        expectedNames
      );
      if (domDiagnostic) {
        console.log(
          `DOM chips=${(domDiagnostic as { chipCount?: number }).chipCount ?? "?"} ` +
            `rawRemove=${(domDiagnostic as { rawDom?: { removeButtonCount?: number } }).rawDom?.removeButtonCount ?? "?"} ` +
            `verify=${(domDiagnostic as { verifyMode?: string }).verifyMode ?? "?"}`
        );
      }
    }

    if (["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(status)) {
      finalStatus = status;
      break;
    }
    await sleep(pollMs);
  }

  if (!finalStatus) {
    console.error(`FAIL: timed out after ${timeoutMs}ms without terminal status`);
    process.exit(1);
  }

  const task = repo.getTaskById(taskId);
  if (domDiagnostic === null) {
    const workerId = task?.leaseOwner ?? "default";
    const worker = repo.getWorkerState(workerId);
    console.log(`fallback terminal DOM scan status=${finalStatus}`);
    domDiagnostic = await captureDomDiagnostics(
      cdpEndpoint,
      worker.workerUrl,
      expectedNames
    );
    if (domDiagnostic) {
      console.log(
        `DOM chips=${(domDiagnostic as { chipCount?: number }).chipCount ?? "?"} ` +
          `rawRemove=${(domDiagnostic as { rawDom?: { removeButtonCount?: number } }).rawDom?.removeButtonCount ?? "?"}`
      );
    }
  }

  const logEvents = parseHandoffLogEvents(taskId);
  if (!logEvents.attached) {
    console.warn("WARN: RESOURCE_ATTACHED not seen in handoff.log");
  }
  let modelResult = "";
  if (!skipModel) {
    const result = taskService.getResult(taskId);
    modelResult = result.result ?? "";
    const needA = markerForIndex(canaryA);
    const needB = markerForIndex(canaryB);
    const gotA = modelResult.includes(needA) || modelResult.includes(`CANARY_${pad2(canaryA)}=${needA}`);
    const gotB = modelResult.includes(needB) || modelResult.includes(`CANARY_${pad2(canaryB)}=${needB}`);
    console.log(`model canary ${pad2(canaryA)}=${gotA ? "OK" : "MISS"} ${pad2(canaryB)}=${gotB ? "OK" : "MISS"}`);
  }

  const report = {
    taskId,
    runTag,
    fileCount: count,
    taskStatus: finalStatus,
    taskError: task?.error ?? null,
    logEvents,
    domDiagnostic,
    domChipCap: CHATGPT_DOM_CHIP_CAP,
    modelResult: skipModel ? "(skipped)" : modelResult.slice(0, 4000),
    interpretation: "",
  };
  report.interpretation = interpretReport(report);

  mkdirSync(LOG_DIR, { recursive: true });
  const outPath = join(LOG_DIR, `attach-observability-${taskId}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`report → ${outPath}`);
  console.log(`interpretation: ${report.interpretation}`);
  console.log(`task status=${finalStatus}${task?.error ? ` error=${task.error}` : ""}`);

  rmSync(wsRoot, { recursive: true, force: true });

  console.log("E2E attach-observability DONE (see report for pass/fail semantics)");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
