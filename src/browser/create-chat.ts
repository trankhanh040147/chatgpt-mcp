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

/** Attach the Cursor plugin from the composer + menu (list, not search). */
async function attachCursorPlugin(page: Page): Promise<void> {
  const plus = page.locator('[data-testid="composer-plus-btn"]').first();
  await plus.waitFor({ state: "visible", timeout: 15_000 });
  await plus.click({ timeout: 5000 });
  await page
    .getByText(/Type to search plugins/i)
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(1500);

  const cursor = page.getByText("Cursor", { exact: true }).first();
  await cursor.waitFor({ state: "visible", timeout: 10_000 });
  await cursor.click({ timeout: 5000 });
  await page.waitForTimeout(800);
}

async function sendBootstrap(page: Page, message: string): Promise<void> {
  const composer = page.locator(selectors.composer).first();
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click({ timeout: 5000 }).catch(async () => {
    await composer.click({ force: true, timeout: 5000 });
  });
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+A" : "Control+A"
  );
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(message);

  const sendButton = page.locator(selectors.sendButton).first();
  if (await sendButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    try {
      await sendButton.click({ timeout: 5000 });
    } catch {
      await sendButton.click({ force: true, timeout: 5000 });
    }
  } else {
    await page.keyboard.press("Enter");
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
  const chatGptUrl = options.chatGptUrl ?? "https://chatgpt.com";
  const timeoutMs = options.timeoutMs ?? 90_000;
  const bootstrapMessage =
    options.bootstrapMessage ??
    "chatgpt-mcp worker bootstrap — reply OK and wait for TASK_ID.";

  const page = await context.newPage();
  try {
    await page.goto(`${chatGptUrl.replace(/\/$/, "")}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(1500);

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
        await page.waitForTimeout(1000);
      }
    }

    let chatId = chatIdFromUrl(page.url());
    if (!chatId) {
      await attachCursorPlugin(page);
      await sendBootstrap(page, bootstrapMessage);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      chatId = chatIdFromUrl(page.url());
      if (chatId) break;
      await page.waitForTimeout(400);
    }

    chatId = chatIdFromUrl(page.url());
    if (!chatId) {
      throw new Error(
        `create-worker: timed out waiting for /c/<id> (url=${page.url()}).`
      );
    }

    const workerUrl = `https://chatgpt.com/c/${chatId}`;
    const composer = page.locator(selectors.composer).first();
    const ready = await composer
      .isVisible({ timeout: 20_000 })
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
  } catch (err) {
    try {
      await page.close();
    } catch {
      // ignore
    }
    throw err;
  }
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
