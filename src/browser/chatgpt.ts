import type { Browser, BrowserContext, Page } from "playwright";
import { selectors, DISPATCH_MESSAGE } from "./selectors.js";
import { log } from "../logging/logger.js";

export interface ChatGptBrowserOptions {
  /** CDP HTTP endpoint of an already-running Chrome, e.g. http://127.0.0.1:9222 */
  cdpEndpoint: string;
  /** Direct URL of the dedicated worker conversation (https://chatgpt.com/c/...). */
  workerUrl: string;
  chatGptUrl: string;
}

/**
 * Attaches to a real Chrome instance that is already logged into ChatGPT.
 * Does not launch a browser, create profiles, or automate login.
 */
export class ChatGptBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private readonly options: ChatGptBrowserOptions) {}

  async connect(): Promise<void> {
    const { chromium } = await import("playwright");
    try {
      // noDefaults: skip Browser.setDownloadBehavior / focus / media overrides.
      // Required on some Chrome CDP attaches that reject context management RPCs.
      this.browser = await chromium.connectOverCDP(this.options.cdpEndpoint, {
        noDefaults: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to attach to Chrome at ${this.options.cdpEndpoint}: ${message}. ` +
          "Start Chrome with remote debugging enabled " +
          `(e.g. --remote-debugging-port=9222), log into ChatGPT, then retry. ` +
          "Do not use a dedicated Playwright automation profile for login."
      );
    }

    this.context = this.browser.contexts()[0] ?? null;
    if (!this.context) {
      throw new Error(
        "Attached to Chrome but found no browser context. " +
          "Open at least one tab in the debugged Chrome instance and retry."
      );
    }

    this.page =
      this.context
        .pages()
        .find((p) => /chatgpt\.com/i.test(p.url())) ??
      this.context.pages()[0] ??
      (await this.context.newPage());

    log({
      event: "INFO",
      component: "browser-worker",
      message: `Attached to Chrome via CDP (${this.options.cdpEndpoint}); using page ${this.page.url() || "(blank)"}`,
    });
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error("Browser not connected");
    }
    return this.page;
  }

  /**
   * Verifies an authenticated ChatGPT session is already present.
   * Never attempts login — returns false / SESSION_NOT_READY instead.
   */
  async ensureSessionReady(): Promise<boolean> {
    const page = this.getPage();
    try {
      if (!/chatgpt\.com/i.test(page.url())) {
        await page.goto(this.options.chatGptUrl, {
          waitUntil: "domcontentloaded",
        });
      }

      await page
        .waitForLoadState("networkidle", { timeout: 15000 })
        .catch(() => {});

      const loggedOut = await page
        .locator(selectors.loggedOutIndicator)
        .first()
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      if (loggedOut) {
        log({
          event: "WORKER_SESSION_LOST",
          component: "browser-worker",
          message:
            "SESSION_NOT_READY: ChatGPT is logged out in the attached Chrome. " +
            "Log in manually in that browser (no automation), then restart the worker.",
        });
        return false;
      }

      await page.waitForSelector(selectors.loggedInIndicator, {
        timeout: 15000,
      });
      return true;
    } catch {
      log({
        event: "WORKER_SESSION_LOST",
        component: "browser-worker",
        message:
          "SESSION_NOT_READY: could not confirm an authenticated ChatGPT session on the attached Chrome.",
      });
      return false;
    }
  }

  /** Navigate to the configured worker conversation URL. Throws if unavailable. */
  async openWorkerConversation(): Promise<void> {
    const page = this.getPage();
    const workerUrl = this.options.workerUrl;

    if (!workerUrl || !/^https?:\/\//i.test(workerUrl)) {
      throw new Error(
        "CHATGPT_WORKER_URL is missing or invalid. Set it to the full worker chat URL " +
          "(e.g. https://chatgpt.com/c/xxxxxxxx)."
      );
    }

    await page.goto(workerUrl, { waitUntil: "domcontentloaded" });
    await page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    // ChatGPT redirects unknown/inaccessible chats back to /.
    const current = page.url();
    if (!/\/c\/[a-z0-9-]+/i.test(current)) {
      await this.screenshotOnFailure("worker-url-redirected");
      throw new Error(
        `Worker URL redirected away from chat (${workerUrl} → ${current}). ` +
          "Open/create the worker conversation in the attached Chrome profile and update CHATGPT_WORKER_URL."
      );
    }

    const composer = page.locator(selectors.composer).first();
    const visible = await composer
      .isVisible({ timeout: 20000 })
      .catch(() => false);
    if (!visible) {
      await this.screenshotOnFailure("worker-url-not-ready");
      throw new Error(
        `Worker conversation not ready at ${workerUrl}. ` +
          "Confirm the URL is a logged-in ChatGPT chat and the composer is visible."
      );
    }
  }

  async submitTaskId(taskId: string): Promise<void> {
    const page = this.getPage();
    const message = DISPATCH_MESSAGE(taskId);

    const composer = page.locator(selectors.composer).first();
    await composer.waitFor({ state: "visible", timeout: 30000 });
    await composer.click();
    // ProseMirror often ignores locator.fill(); clear + type instead.
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    );
    await page.keyboard.type(message, { delay: 5 });

    const sendButton = page.locator(selectors.sendButton).first();
    if (await sendButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sendButton.click();
    } else {
      await page.keyboard.press("Enter");
    }

    await page.waitForTimeout(1000);
  }

  async detectRateLimit(): Promise<boolean> {
    const page = this.getPage();
    const banner = page.locator(selectors.rateLimitBanner).first();
    return banner.isVisible({ timeout: 2000 }).catch(() => false);
  }

  async screenshotOnFailure(name: string): Promise<void> {
    try {
      const page = this.getPage();
      await page.screenshot({
        path: `./logs/failure-${name}-${Date.now()}.png`,
        fullPage: true,
      });
    } catch {
      // ignore screenshot failures
    }
  }

  /** Disconnect Playwright from Chrome without quitting the user's browser. */
  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // ignore disconnect errors on shutdown
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}
