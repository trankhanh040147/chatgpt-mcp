import type { Browser, Page } from "playwright";
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
  browser: Browser;
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
 * Assisted New chat on an already-logged-in CDP Chrome.
 * Does not log in, approve MCP, or write topology.
 * Sends a short bootstrap message so ChatGPT allocates /c/<id>.
 */
export async function createWorkerChat(
  options: CreateWorkerChatOptions
): Promise<CreatedWorkerChat> {
  const chatGptUrl = options.chatGptUrl ?? "https://chatgpt.com";
  const timeoutMs = options.timeoutMs ?? 90_000;
  const bootstrapMessage =
    options.bootstrapMessage ??
    "chatgpt-mcp worker bootstrap — reply OK and wait for TASK_ID.";
  const { chromium } = await import("playwright");

  let browser: Browser;
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

  const page = await context.newPage();
  try {
    // Landing "/" is a blank new chat until the first send allocates /c/<id>.
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

    // Best-effort New chat click if we landed on an existing conversation.
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
        `create-worker: timed out waiting for /c/<id> (url=${page.url()}). ` +
          "Create a chat manually in the CDP Chrome and pass --worker-url instead."
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

    return { workerUrl, chatId, page, browser };
  } catch (err) {
    try {
      await page.close();
    } catch {
      // ignore
    }
    try {
      await browser.close();
    } catch {
      // ignore
    }
    throw err;
  }
}
