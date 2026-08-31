import type { BrowserContext, Page } from "playwright";
import { selectors } from "./selectors.js";
import { chatIdFromUrl } from "./chat-url.js";
import { log } from "../logging/logger.js";

export interface CreateWorkerChatOptions {
  cdpEndpoint: string;
  chatGptUrl?: string;
  /** Max wait for /c/<id> after New chat (ms). */
  timeoutMs?: number;
  /**
   * First message that forces ChatGPT to allocate /c/<id>.
   * Kept short — not a real handoff.
   */
  bootstrapMessage?: string;
}

export interface CreatedWorkerChat {
  workerUrl: string;
  chatId: string;
  page: Page;
  browser: import("playwright").Browser;
}

export interface CreateWorkerChatOnContextOptions {
  chatGptUrl?: string;
  timeoutMs?: number;
  bootstrapMessage?: string;
  /** When aborted (cancel / disable), stop opening tabs and throw. */
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("worker-op cancelled");
  }
}

export interface CreatedWorkerChatOnContext {
  workerUrl: string;
  chatId: string;
  page: Page;
}

/**
 * ChatGPT web defaults to Work (shared Codex/agentic pool). Worker handoffs
 * should run on Chat so they do not consume Work/Codex credits.
 */
async function ensureChatSurface(page: Page): Promise<void> {
  const chatRadio = page.getByRole("radio", { name: "Chat", exact: true });
  const visible = await chatRadio.isVisible({ timeout: 5000 }).catch(() => false);
  if (!visible) return;

  const checked = await chatRadio.getAttribute("aria-checked");
  if (checked === "true") return;

  await chatRadio.click({ timeout: 5000 });
  await page.waitForTimeout(800);
  const after = await chatRadio.getAttribute("aria-checked");
  if (after !== "true") {
    throw new Error(
      "create-worker: failed to switch ChatGPT surface from Work to Chat. " +
        "Switch manually to Chat in the CDP Chrome, then retry."
    );
  }
}

/** Plain composer text — chips may render without "@Cursor" literals. */
async function readComposerText(page: Page): Promise<string> {
  const composer = page.locator(selectors.composer).first();
  const text =
    (await composer.innerText().catch(() => null)) ??
    (await composer.textContent().catch(() => null)) ??
    "";
  return text.replace(/\s+/g, " ").trim();
}

function countPlainCursorMentions(text: string): number {
  return (text.match(/@Cursor/gi) ?? []).length;
}

/** @mention autocomplete row for the Cursor connector (below composer, not sidebar). */
async function findCursorMentionSuggestion(
  page: Page
): Promise<{ x: number; y: number; text: string } | null> {
  const composer = page.locator(selectors.composer).first();
  const box = await composer.boundingBox();
  if (!box) return null;

  return page.evaluate(
    (a) => {
      const minX = Math.max(180, a.cx - 24);
      const maxX = a.cx + a.cw + 24;
      // Strictly below composer — never match typed "@Cursor" inside the editor.
      const minY = a.cy + a.ch + 4;
      const maxY = a.cy + a.ch + 360;

      const composerRoot =
        document.querySelector(
          '#prompt-textarea[contenteditable="true"], div#prompt-textarea[role="textbox"], [contenteditable="true"].ProseMirror'
        ) ?? null;

      function normalize(text: string): string {
        return text.replace(/\s+/g, " ").trim();
      }

      function score(text: string): number {
        if (!text) return -1;
        if (/^@Cursor$/i.test(text)) return -1;
        if (/request|handoff|trading|analysis of stocks/i.test(text)) return -1;
        if (text === "Cursor") return 100;
        if (/^Cursor Cursor$/i.test(text)) return 95;
        if (/^Cursor\b/i.test(text) && text.length <= 32) return 60;
        return -1;
      }

      let best: { el: Element; s: number; text: string } | null = null;
      for (const el of document.querySelectorAll(
        "div, span, button, li, p, [role='option']"
      )) {
        if (composerRoot?.contains(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.x < minX || r.x > maxX || r.y < minY || r.y > maxY) continue;
        const text = normalize(el.textContent ?? "");
        const s = score(text);
        if (s < 0) continue;
        if (!best || s > best.s) {
          best = { el, s, text };
        }
      }

      if (!best) return null;
      const r = best.el.getBoundingClientRect();
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        text: best.text,
      };
    },
    { cx: box.x, cy: box.y, cw: box.width, ch: box.height }
  );
}

async function waitForCursorMentionSuggestion(
  page: Page,
  timeoutMs = 15_000
): Promise<{ x: number; y: number; text: string }> {
  const deadline = Date.now() + timeoutMs;
  let loggedWait = false;
  while (Date.now() < deadline) {
    const hit = await findCursorMentionSuggestion(page);
    if (hit) {
      if (!loggedWait) {
        loggedWait = true;
        log({
          event: "INFO",
          component: "create-worker",
          message: `create-worker: @mention suggestion visible (${hit.text})`,
        });
      }
      // Let ChatGPT finish highlighting the row before we confirm.
      await page.waitForTimeout(220);
      return hit;
    }
    if (!loggedWait) {
      loggedWait = true;
      log({
        event: "INFO",
        component: "create-worker",
        message:
          "create-worker: waiting for @Cursor mention suggestion below composer",
      });
    }
    await page.waitForTimeout(120);
  }
  throw new Error(
    "create-worker: @Cursor mention list did not appear — type @Cursor manually, pick Cursor, then Assign URL"
  );
}

async function mentionMenuVisible(page: Page): Promise<boolean> {
  return page
    .locator('[role="listbox"], [role="menu"]')
    .first()
    .isVisible({ timeout: 200 })
    .catch(() => false);
}

async function confirmCursorMentionSuggestion(
  page: Page,
  suggestion: { x: number; y: number; text: string }
): Promise<void> {
  const beforeText = await readComposerText(page);

  // One confirm path — keyboard first (matches manual flow). Avoid click+Enter double-confirm.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
  if (await cursorConnectorOnComposer(page)) return;

  const afterEnter = await readComposerText(page);
  if (countPlainCursorMentions(afterEnter) > countPlainCursorMentions(beforeText)) {
    // Enter committed plain text instead of the chip — undo and click the row once.
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(200);
  }

  try {
    await page.mouse.click(suggestion.x, suggestion.y);
    await page.waitForTimeout(350);
    if (await cursorConnectorOnComposer(page)) return;
  } catch {
    /* optional click failed */
  }

  if (await mentionMenuVisible(page)) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
  }
}

/** Remove accidental duplicate plain "@Cursor" literals left in the composer. */
async function dedupePlainCursorMentions(page: Page): Promise<void> {
  const text = await readComposerText(page);
  if (countPlainCursorMentions(text) < 2) return;

  const composer = page.locator(selectors.composer).first();
  await composer.click({ timeout: 3000 }).catch(() => undefined);
  for (let i = 0; i < countPlainCursorMentions(text) - 1; i += 1) {
    await page.keyboard.press("Meta+ArrowLeft");
    await page.keyboard.press("Shift+Meta+ArrowRight");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(80);
  }
}

/** Cursor MCP chip attached to the composer (not sidebar "Cursor" plugin link). */
async function cursorConnectorOnComposer(page: Page): Promise<boolean> {
  const composer = page.locator(selectors.composer).first();
  if (
    await composer
      .getByText(/^Cursor$/i)
      .first()
      .isVisible({ timeout: 600 })
      .catch(() => false)
  ) {
    return true;
  }
  const composerForm = page
    .locator("form")
    .filter({ has: composer })
    .first();
  if (
    await composerForm
      .getByText(/^Cursor$/i)
      .first()
      .isVisible({ timeout: 600 })
      .catch(() => false)
  ) {
    return true;
  }
  const trailing = page.locator('[data-testid="composer-trailing-actions"]');
  if (
    await trailing
      .getByText(/Cursor/i)
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false)
  ) {
    return true;
  }
  const leading = page.locator('[data-testid="composer-leading-actions"]');
  if (
    await leading
      .getByText(/Cursor/i)
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false)
  ) {
    return true;
  }
  return false;
}

async function waitForCursorConnector(
  page: Page,
  timeoutMs = 12_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let loggedWait = false;
  while (Date.now() < deadline) {
    if (await cursorConnectorOnComposer(page)) {
      await page.waitForTimeout(200);
      return;
    }
    if (!loggedWait) {
      loggedWait = true;
      log({
        event: "INFO",
        component: "create-worker",
        message: "create-worker: waiting for Cursor chip on composer after @Cursor mention",
      });
    }
    await page.waitForTimeout(120);
  }
  throw new Error(
    "create-worker: Cursor connector did not attach to the composer — type @Cursor in the composer manually, then Assign URL"
  );
}

/** Attach Cursor via composer @mention autocomplete (@Cursor → Enter). */
async function attachCursorPlugin(page: Page): Promise<void> {
  if (await cursorConnectorOnComposer(page)) {
    log({
      event: "INFO",
      component: "create-worker",
      message: "create-worker: Cursor already on composer — skip @mention",
    });
    await page.waitForTimeout(200);
    return;
  }

  const composer = page.locator(selectors.composer).first();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await composer.click({ timeout: 5000 }).catch(async () => {
    await composer.click({ force: true, timeout: 5000 });
  });
  await page.waitForTimeout(100);

  await dedupePlainCursorMentions(page);

  const existingText = await readComposerText(page);
  if (
    countPlainCursorMentions(existingText) === 0 &&
    !(await cursorConnectorOnComposer(page))
  ) {
    await page.keyboard.type("@Cursor", { delay: 45 });
  }

  const suggestion = await waitForCursorMentionSuggestion(page);
  await confirmCursorMentionSuggestion(page, suggestion);
  await dedupePlainCursorMentions(page);
  await waitForCursorConnector(page);
}

async function waitForChatId(
  page: Page,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const immediate = chatIdFromUrl(page.url());
  if (immediate) return immediate;

  try {
    await page.waitForURL(/\/c\/[a-z0-9-]+/i, {
      timeout: Math.min(timeoutMs, 45_000),
      waitUntil: "commit",
    });
  } catch {
    /* SPA may use pushState without a navigation event */
  }

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const chatId = chatIdFromUrl(page.url());
    if (chatId) return chatId;
    await page.waitForTimeout(100);
  }

  throw new Error(
    `create-worker: timed out waiting for /c/<id> (url=${page.url()}).`
  );
}

async function sendBootstrap(page: Page, message: string): Promise<void> {
  const composer = page.locator(selectors.composer).first();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(150);

  await composer.click({ timeout: 5000 }).catch(async () => {
    await composer.click({ force: true, timeout: 5000 });
  });
  await page.waitForTimeout(100);

  // Do not Meta+A — can clear connector chip; append bootstrap at end.
  await page.keyboard.type(message, { delay: 20 });

  const sendButton = page.locator(selectors.sendButton).first();
  await sendButton.waitFor({ state: "visible", timeout: 8_000 });
  await page.waitForTimeout(100);
  try {
    await sendButton.click({ timeout: 5000 });
  } catch {
    await sendButton.click({ force: true, timeout: 5000 });
  }
}

/**
 * Create a new worker chat on an existing broker-owned BrowserContext.
 * Does not connect CDP — broker must own the context (ADR-009).
 */
export async function createWorkerChatOnContext(
  context: BrowserContext,
  options: CreateWorkerChatOnContextOptions = {}
): Promise<CreatedWorkerChatOnContext> {
  const page = await context.newPage();
  try {
    return await completeWorkerChatOnPage(page, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!page.isClosed()) {
      log({
        event: "WARN",
        component: "create-worker",
        message: `create-worker: automation failed — tab left open: ${message}`,
      });
    }
    throw err;
  }
}

/**
 * Finish new-chat automation on an already-open tab (broker opens the tab
 * outside the UI mutex so the operator sees progress immediately).
 */
export async function completeWorkerChatOnPage(
  page: Page,
  options: CreateWorkerChatOnContextOptions = {}
): Promise<CreatedWorkerChatOnContext> {
  const signal = options.signal;
  throwIfAborted(signal);

  const chatGptUrl = options.chatGptUrl ?? "https://chatgpt.com";
  const timeoutMs = options.timeoutMs ?? 90_000;
  const bootstrapMessage =
    options.bootstrapMessage ?? "OK";

  await page.goto(`${chatGptUrl.replace(/\/$/, "")}/`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const composerProbe = page.locator(selectors.composer).first();
  await composerProbe
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => undefined);
  throwIfAborted(signal);

  const loggedOut = await page
    .locator(selectors.loggedOutIndicator)
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  if (loggedOut) {
    throw new Error(
      "SESSION_NOT_READY: ChatGPT is logged out. Log in manually in the CDP Chrome, then retry."
    );
  }

  await ensureChatSurface(page);

  if (chatIdFromUrl(page.url())) {
    const newChat = page
      .locator('[data-testid="create-new-chat-button"]')
      .first();
    if (await newChat.isVisible({ timeout: 3000 }).catch(() => false)) {
      try {
        await newChat.click({ force: true, timeout: 5000 });
      } catch {
        await page.goto(`${chatGptUrl.replace(/\/$/, "")}/`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
      }
      await page.waitForTimeout(400);
    }
  }

  let chatId = chatIdFromUrl(page.url());
  if (!chatId) {
    throwIfAborted(signal);
    await attachCursorPlugin(page);
    throwIfAborted(signal);
    await sendBootstrap(page, bootstrapMessage);
    chatId = await waitForChatId(page, timeoutMs, signal);
  }

  const workerUrl = `https://chatgpt.com/c/${chatId}`;
  const composer = page.locator(selectors.composer).first();
  const ready = await composer
    .isVisible({ timeout: 8_000 })
    .catch(() => false);
  if (!ready) {
    throw new Error(
      `create-worker: composer not ready at ${workerUrl} — check login / UI`
    );
  }

  log({
    event: "INFO",
    component: "create-worker",
    message: `create-worker: captured chat=${chatId}`,
  });

  return { workerUrl, chatId, page };
}

/**
 * Assisted New chat on an already-logged-in CDP Chrome (legacy CLI path).
 * Opens its own CDP connection — do not use when browser-broker is running.
 */
export async function createWorkerChat(
  options: CreateWorkerChatOptions
): Promise<CreatedWorkerChat> {
  const { chromium } = await import("playwright");

  let browser: import("playwright").Browser;
  try {
    browser = await chromium.connectOverCDP(options.cdpEndpoint, {
      noDefaults: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `create-worker: CDP attach failed at ${options.cdpEndpoint}: ${message}`
    );
  }

  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new Error(
      "create-worker: no browser context — open at least one tab in the CDP Chrome"
    );
  }

  try {
    const created = await createWorkerChatOnContext(context, {
      chatGptUrl: options.chatGptUrl,
      timeoutMs: options.timeoutMs,
      bootstrapMessage: options.bootstrapMessage,
    });
    return { ...created, browser };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}
