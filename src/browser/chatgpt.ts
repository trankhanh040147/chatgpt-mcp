import type { Browser, BrowserContext, Page } from "playwright";
import { selectors, DISPATCH_MESSAGE } from "./selectors.js";
import type { McpDomHint } from "../mcp/probe-failure.js";
import {
  PROBE_SUBMIT_NUDGE_MESSAGE,
  SUBMIT_NUDGE_MESSAGE,
} from "../mcp/worker-policy.js";
import { log } from "../logging/logger.js";
import { sameWorkerChat } from "./chat-url.js";

export interface ChatGptBrowserOptions {
  /** CDP HTTP endpoint of an already-running Chrome, e.g. http://127.0.0.1:9222 */
  cdpEndpoint: string;
  /** Direct URL of the dedicated worker conversation (https://chatgpt.com/c/...). */
  workerUrl: string;
  chatGptUrl: string;
}

export interface SharedPageAttachOptions {
  browser: Browser;
  context: BrowserContext;
  page: Page;
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
  /** When false (broker-bound page), close() must not disconnect CDP. */
  private ownsConnection = true;

  constructor(private readonly options: ChatGptBrowserOptions) {}

  /** Bind an existing Playwright page owned by BrowserBroker (A1-S). */
  static attachShared(opts: SharedPageAttachOptions): ChatGptBrowser {
    const instance = new ChatGptBrowser({
      cdpEndpoint: "shared",
      workerUrl: opts.workerUrl,
      chatGptUrl: opts.chatGptUrl,
    });
    instance.browser = opts.browser;
    instance.context = opts.context;
    instance.page = opts.page;
    instance.ownsConnection = false;
    return instance;
  }

  async connect(): Promise<void> {
    if (!this.ownsConnection && this.page) {
      return;
    }
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
        .find((p) => {
          const workerUrl = this.options.workerUrl;
          if (workerUrl && p.url().startsWith(workerUrl.split("?")[0]!)) {
            return true;
          }
          return /chatgpt\.com\/c\//i.test(p.url());
        }) ??
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

  async detectChatAccessDenied(): Promise<boolean> {
    const page = this.getPage();
    return await page
      .locator(selectors.chatAccessDenied)
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);
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

      if (await this.detectChatAccessDenied()) {
        log({
          event: "WORKER_SESSION_LOST",
          component: "browser-worker",
          message:
            "CHAT_ACCESS_DENIED: logged-in account cannot open this /c/ URL. " +
            "Create a new chat in CDP Chrome and Assign URL on the dashboard.",
        });
        return false;
      }

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

    // Reloading mid-stream drops composer text and can steal TASK_ID.
    if (!sameWorkerChat(page.url(), workerUrl)) {
      await page.goto(workerUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page
        .waitForLoadState("networkidle", { timeout: 15_000 })
        .catch(() => {});
      await page.waitForTimeout(1500);
    }

    if (await this.detectChatAccessDenied()) {
      throw new Error(
        "CHAT_ACCESS_DENIED: this account cannot open the worker chat URL. " +
          "In CDP Chrome: New chat → send a test message → Assign URL on the dashboard."
      );
    }

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

  async isGenerating(): Promise<boolean> {
    const page = this.getPage();
    const stop = page.locator(selectors.stopButton).first();
    return stop.isVisible({ timeout: 400 }).catch(() => false);
  }

  /**
   * Best-effort DOM classification for MCP write failures (probe instrumentation).
   * Does not prove remote-mcp ingress — pairs with server access logs.
   */
  async detectMcpDomHint(probeToken?: string): Promise<McpDomHint> {
    const page = this.getPage();

    const allowVisible = await page
      .locator(
        'button:has-text("Allow"), button:has-text("Always allow"), button:has-text("Approve")'
      )
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false);
    if (allowVisible) return "approval_required";

    const allowCard = await page
      .getByText(/Allow ChatGPT to use/i)
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false);
    if (allowCard) return "approval_required";

    const assistantTexts = await page
      .locator('[data-message-author-role="assistant"]')
      .allTextContents()
      .catch(() => [] as string[]);
    const combined = assistantTexts.join("\n");

    if (
      /blocked by (?:openai.?s|the platform.?s) safety checks/i.test(combined) ||
      /safety checks blocked/i.test(combined) ||
      (/tool call was blocked/i.test(combined) && /safety/i.test(combined)) ||
      /unable to complete.*blocked by.*safety/i.test(combined)
    ) {
      return "safety_blocked";
    }

    if (probeToken) {
      const canaryRe = new RegExp(`CREATE_WORKER_CANARY=${probeToken}(?:\\b|[^a-zA-Z0-9])`);
      if (canaryRe.test(combined)) {
        return "canary_in_chat";
      }
    }

    return null;
  }

  /** Public idle wait — must run outside the UI-write mutex. */
  async waitUntilComposerIdle(): Promise<void> {
    await this.waitForComposerIdle(this.getPage());
  }

  async submitTaskId(
    taskId: string,
    opts?: { skipIdleWait?: boolean; attachmentCount?: number }
  ): Promise<void> {
    const page = this.getPage();
    const message = DISPATCH_MESSAGE(taskId);
    const marker = `TASK_ID=${taskId}`;
    const attachmentCount = opts?.attachmentCount ?? 0;
    const sendWaitMs =
      attachmentCount > 0
        ? Math.min(180_000, 10_000 + 500 * attachmentCount)
        : 15_000;
    const clearDeadlineMs = Math.max(30_000, sendWaitMs);

    const composer = page.locator(selectors.composer).first();
    await composer.waitFor({ state: "visible", timeout: 30000 });

    // User turns only — matching `text=TASK_ID=…` also hits the composer
    // and used to skip send after a failed type-into-box.
    const alreadySent = await page
      .locator('[data-message-author-role="user"]')
      .filter({ hasText: marker })
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
    if (alreadySent) {
      log({
        event: "INFO",
        component: "browser-worker",
        taskId,
        message: "Dispatch message already present in chat; skipping resend",
      });
      return;
    }

    if (!opts?.skipIdleWait) {
      await this.waitForComposerIdle(page);
    }
    await this.fillComposer(page, composer, message, {
      preserveAttachments: attachmentCount > 0,
    });

    const typed = ((await composer.innerText().catch(() => "")) ?? "").replace(
      /\s+/g,
      " "
    );
    if (!typed.includes(marker)) {
      throw new Error(
        `Composer did not retain dispatch text for ${taskId} (got: ${typed.slice(0, 80)})`
      );
    }

    if (attachmentCount > 0) {
      log({
        event: "INFO",
        component: "browser-worker",
        taskId,
        message: `Waiting for Send enabled after ${attachmentCount} attachment(s) (budget=${sendWaitMs}ms)`,
      });
    }

    await this.clickSendUntilComposerClears(page, composer, marker, {
      sendReadyMs: sendWaitMs,
      clearDeadlineMs,
    });
  }

  /** Short reminder to call handoff_submit_result (best-effort, idempotent per nudge stage). */
  async sendSubmitNudge(
    taskId: string,
    opts?: { skipIdleWait?: boolean; probe?: boolean }
  ): Promise<void> {
    const page = this.getPage();
    const message = opts?.probe
      ? PROBE_SUBMIT_NUDGE_MESSAGE(taskId)
      : SUBMIT_NUDGE_MESSAGE(taskId);
    const marker = `TASK_ID=${taskId}`;

    const composer = page.locator(selectors.composer).first();
    await composer.waitFor({ state: "visible", timeout: 15000 });
    if (!opts?.skipIdleWait) {
      await this.waitForComposerIdle(page);
    }
    await this.fillComposer(page, composer, message);

    await this.clickSendUntilComposerClears(page, composer, marker);

    log({
      event: "INFO",
      component: "browser-worker",
      taskId,
      message: `Sent submit nudge (${marker})`,
    });
  }

  /**
   * Click Send (or Enter) until the dispatch text leaves the composer.
   * Matching `text=TASK_ID=…` in the page is not enough — that hits the
   * composer itself and used to ack a typed-but-unsent message.
   */
  private async waitForSendEnabled(page: Page, timeoutMs: number): Promise<void> {
    const sendButton = page.locator(selectors.sendButton).first();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await sendButton
        .evaluate((btn) => {
          if (!(btn instanceof HTMLButtonElement)) return false;
          if (!btn.offsetParent) return false;
          return !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
        })
        .catch(() => false);
      if (ready) return;
      await page.waitForTimeout(250);
    }
    throw new Error(`Send button not enabled within ${timeoutMs}ms`);
  }

  private async clickSendUntilComposerClears(
    page: Page,
    composer: ReturnType<Page["locator"]>,
    marker: string,
    opts?: { sendReadyMs?: number; clearDeadlineMs?: number }
  ): Promise<void> {
    const sendReadyMs = opts?.sendReadyMs ?? 15_000;
    const clearDeadlineMs = opts?.clearDeadlineMs ?? 30_000;

    await this.waitForSendEnabled(page, sendReadyMs);

    const sendButton = page.locator(selectors.sendButton).first();
    const attemptSend = async (): Promise<void> => {
      if (await sendButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        try {
          await sendButton.click({ timeout: 5000 });
        } catch {
          await sendButton.click({ force: true, timeout: 5000 });
        }
      } else {
        await page.keyboard.press("Enter");
      }
    };

    await attemptSend();
    const deadline = Date.now() + clearDeadlineMs;
    while (Date.now() < deadline) {
      const composerText = (
        (await composer.innerText().catch(() => "")) ?? ""
      ).trim();
      if (!composerText.includes(marker)) return;
      await this.waitForSendEnabled(page, 3_000).catch(() => undefined);
      await attemptSend();
      await page.waitForTimeout(500);
    }

    await page.keyboard.press("Enter");
    await attemptSend();
    await page.waitForTimeout(800);
    const leftover = ((await composer.innerText().catch(() => "")) ?? "").trim();
    if (leftover.includes(marker)) {
      throw new Error(
        `Dispatch typed but not sent (composer still has ${marker})`
      );
    }
  }

  /** Wait until ChatGPT is not streaming — Send stays disabled while composer is empty. */
  private async waitForComposerIdle(page: Page): Promise<void> {
    const stop = page.locator(selectors.stopButton).first();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const streaming = await stop.isVisible({ timeout: 400 }).catch(() => false);
      if (!streaming) return;
      await page.waitForTimeout(500);
    }
    throw new Error(
      "ChatGPT is still generating after 60s — wait for the composer to idle, then retry"
    );
  }

  private async fillComposer(
    page: Page,
    composer: ReturnType<Page["locator"]>,
    message: string,
    opts?: { preserveAttachments?: boolean }
  ): Promise<void> {
    await composer.scrollIntoViewIfNeeded().catch(() => undefined);
    await composer.evaluate((el) => {
      (el as HTMLElement).focus();
    });
    try {
      await composer.click({ timeout: 5000 });
    } catch {
      await composer.click({ force: true, timeout: 5000 });
    }

    if (opts?.preserveAttachments) {
      await page.keyboard.press("End");
      const existing = ((await composer.innerText().catch(() => "")) ?? "").trim();
      if (!existing.includes(message)) {
        if (existing.length > 0) {
          await page.keyboard.insertText(`\n${message}`);
        } else {
          await page.keyboard.insertText(message);
        }
      }
      return;
    }

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    );
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(message);
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
    if (!this.ownsConnection) {
      // Broker owns the CDP socket — drop local refs only.
      this.browser = null;
      this.context = null;
      this.page = null;
      return;
    }
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
