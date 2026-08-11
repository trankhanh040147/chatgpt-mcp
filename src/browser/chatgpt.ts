import type { BrowserContext, Page } from "playwright";
import { selectors, DISPATCH_MESSAGE } from "./selectors.js";
import { log } from "../logging/logger.js";

export interface ChatGptBrowserOptions {
  profilePath: string;
  chatGptUrl: string;
  workerConversationTitle: string;
  /** Playwright browser channel, e.g. "chrome" to use a real installed Chrome
   *  instead of the bundled "Chrome for Testing" binary. The bundled test
   *  build has an automation-specific fingerprint that bot-detection services
   *  flag more aggressively; a real Chrome binary (still with its own
   *  isolated, dedicated profile — not the user's daily one) is less likely
   *  to trip that. Falls back to the bundled Chromium if unavailable. */
  channel?: string;
}

export class ChatGptBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private readonly options: ChatGptBrowserOptions) {}

  async launch(): Promise<void> {
    const { chromium } = await import("playwright");
    try {
      this.context = await chromium.launchPersistentContext(
        this.options.profilePath,
        {
          headless: false,
          viewport: { width: 1280, height: 900 },
          channel: this.options.channel,
        }
      );
    } catch (err) {
      if (!this.options.channel) throw err;
      log({
        event: "WARN",
        component: "browser-worker",
        message: `Failed to launch browser channel "${this.options.channel}" (${
          err instanceof Error ? err.message : String(err)
        }); falling back to bundled Chromium.`,
      });
      this.context = await chromium.launchPersistentContext(
        this.options.profilePath,
        { headless: false, viewport: { width: 1280, height: 900 } }
      );
    }
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(this.options.chatGptUrl, {
      waitUntil: "domcontentloaded",
    });
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error("Browser not launched");
    }
    return this.page;
  }

  async ensureLoggedIn(): Promise<boolean> {
    const page = this.getPage();
    try {
      // Let the SPA finish its client-side auth check before reading DOM state.
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

      const loggedOut = await page
        .locator(selectors.loggedOutIndicator)
        .first()
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      if (loggedOut) {
        log({
          event: "WORKER_SESSION_LOST",
          component: "browser-worker",
          message: "ChatGPT session not detected (anonymous/logged-out page). Manual login required.",
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
        message: "ChatGPT session not detected. Manual login required.",
      });
      return false;
    }
  }

  async openWorkerConversation(): Promise<void> {
    const page = this.getPage();
    const title = this.options.workerConversationTitle;

    const link = page.locator(selectors.conversationLink(title)).first();
    if (await link.isVisible({ timeout: 5000 }).catch(() => false)) {
      await link.click();
      await page.waitForLoadState("domcontentloaded");
      return;
    }

    log({
      event: "INFO",
      component: "browser-worker",
      message: `Worker conversation "${title}" not found. Create it manually and re-run.`,
    });
    await this.screenshotOnFailure("conversation-not-found");
  }

  async submitTaskId(taskId: string): Promise<void> {
    const page = this.getPage();
    const message = DISPATCH_MESSAGE(taskId);

    const composer = page.locator(selectors.composer).first();
    await composer.waitFor({ state: "visible", timeout: 30000 });
    await composer.click();
    await composer.fill(message);

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

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }
}
