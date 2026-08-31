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

  await page.keyboard.type("@Cursor", { delay: 25 });
  await page.waitForTimeout(250);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
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
