import type { Browser, BrowserContext, Page } from "playwright";
import { ChatGptBrowser } from "./chatgpt.js";
import { UiWriteMutex } from "./ui-write-mutex.js";
import { log } from "../logging/logger.js";
import { chatIdFromUrl } from "./chat-url.js";

export interface BrokerWorkerBinding {
  workerId: string;
  workerUrl: string;
  page: Page;
  /** Per-worker rebind counter (page replacement). */
  generation: number;
  /** Broker CDP connection generation (invalidates all pages on disconnect). */
  connectionGeneration: number;
  chatId: string;
  browser: ChatGptBrowser;
}

export interface BrowserBrokerOptions {
  cdpEndpoint: string;
  chatGptUrl: string;
  workers: Array<{ id: string; workerUrl: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A1-S exclusive CDP owner: one Playwright connection, N page-bound ChatGptBrowser
 * adapters, one global UI-write mutex for assert+type/send.
 */
export class BrowserBroker {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly bindings = new Map<string, BrokerWorkerBinding>();
  /** chatId → workerId (unique ownership). */
  private readonly chatOwners = new Map<string, string>();
  private bindChain: Promise<void> = Promise.resolve();
  private connectionGeneration = 0;
  private healthy = false;
  private reconnecting = false;
  private closed = false;
  readonly uiWriteMutex = new UiWriteMutex();

  constructor(private readonly options: BrowserBrokerOptions) {
    if (options.workers.length < 1) {
      throw new Error("BrowserBroker requires at least one worker binding");
    }
    const ids = new Set(options.workers.map((w) => w.id));
    if (ids.size !== options.workers.length) {
      throw new Error("BrowserBroker worker ids must be unique");
    }
    const urls = new Set(options.workers.map((w) => w.workerUrl));
    if (urls.size !== options.workers.length) {
      throw new Error("BrowserBroker worker URLs must be unique");
    }
    const chatIds = options.workers.map((w) => chatIdFromUrl(w.workerUrl));
    if (chatIds.some((c) => !c)) {
      throw new Error("BrowserBroker workerUrl must include /c/<id>");
    }
    if (new Set(chatIds).size !== chatIds.length) {
      throw new Error("BrowserBroker chat ids must be unique");
    }
  }

  getConnectionGeneration(): number {
    return this.connectionGeneration;
  }

  isHealthy(): boolean {
    return this.healthy && !this.closed;
  }

  async connect(): Promise<void> {
    await this.attachAndBindAll();
  }

  private async attachAndBindAll(): Promise<void> {
    const { chromium } = await import("playwright");
    try {
      this.browser = await chromium.connectOverCDP(this.options.cdpEndpoint, {
        noDefaults: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Broker failed to attach to Chrome at ${this.options.cdpEndpoint}: ${message}`
      );
    }

    this.context = this.browser.contexts()[0] ?? null;
    if (!this.context) {
      throw new Error(
        "Broker attached but found no browser context — open at least one tab"
      );
    }

    this.connectionGeneration += 1;
    this.bindings.clear();
    this.chatOwners.clear();

    for (const w of this.options.workers) {
      await this.bindWorker(w.id, w.workerUrl);
    }

    this.healthy = true;
    this.browser.on("disconnected", () => {
      void this.handleDisconnect();
    });

    log({
      event: "INFO",
      component: "browser-broker",
      message: `Broker ready cdp=${this.options.cdpEndpoint} gen=${this.connectionGeneration} workers=[${[...this.bindings.keys()].join(",")}]`,
    });
  }

  private async handleDisconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.healthy = false;
    const deadGen = this.connectionGeneration;
    this.bindings.clear();
    this.chatOwners.clear();
    this.browser = null;
    this.context = null;
    log({
      event: "WARN",
      component: "browser-broker",
      message: `CDP disconnected (gen=${deadGen}) — reconnecting`,
    });

    try {
      for (let attempt = 1; attempt <= 12; attempt++) {
        if (this.closed) return;
        await sleep(Math.min(30_000, 1500 * attempt));
        try {
          await this.attachAndBindAll();
          log({
            event: "INFO",
            component: "browser-broker",
            message: `CDP reconnected gen=${this.connectionGeneration}`,
          });
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log({
            event: "WARN",
            component: "browser-broker",
            message: `Reconnect attempt ${attempt} failed: ${message}`,
          });
        }
      }
      log({
        event: "ERROR",
        component: "browser-broker",
        message: "CDP reconnect exhausted — broker unhealthy",
      });
    } finally {
      this.reconnecting = false;
    }
  }

  private async withBindLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.bindChain;
    this.bindChain = prev.then(
      () => gate,
      () => gate
    );
    await prev.then(
      () => undefined,
      () => undefined
    );
    try {
      return await fn();
    } finally {
      release();
    }
  }

  getBinding(workerId: string): BrokerWorkerBinding {
    const b = this.bindings.get(workerId);
    if (!b) throw new Error(`No broker binding for worker ${workerId}`);
    return b;
  }

  listBindings(): BrokerWorkerBinding[] {
    return [...this.bindings.values()];
  }

  /**
   * Fail-closed: exact chat id match, unique among bindings.
   * Serialized — concurrent binds cannot race on the same chat/page.
   */
  async bindWorker(
    workerId: string,
    workerUrl: string
  ): Promise<BrokerWorkerBinding> {
    return this.withBindLock(() => this.bindWorkerLocked(workerId, workerUrl));
  }

  private async bindWorkerLocked(
    workerId: string,
    workerUrl: string
  ): Promise<BrokerWorkerBinding> {
    if (!this.context || !this.browser) {
      throw new Error("Broker not connected");
    }
    const chatId = chatIdFromUrl(workerUrl);
    if (!chatId) {
      throw new Error(`Invalid workerUrl (need /c/<id>): ${workerUrl}`);
    }

    const owner = this.chatOwners.get(chatId);
    if (owner && owner !== workerId) {
      throw new Error(
        `Duplicate chat binding: ${chatId} already owned by ${owner}`
      );
    }

    // Prefer a page already owned by this worker; else find by chat id unused.
    let page: Page | null = null;
    const prev = this.bindings.get(workerId);
    if (prev && !prev.page.isClosed() && chatIdFromUrl(prev.page.url()) === chatId) {
      page = prev.page;
    } else {
      page =
        this.context.pages().find((p) => {
          if (chatIdFromUrl(p.url()) !== chatId) return false;
          for (const b of this.bindings.values()) {
            if (b.workerId !== workerId && b.page === p) return false;
          }
          return true;
        }) ?? null;
    }

    if (!page) {
      page = await this.context.newPage();
      await page.goto(workerUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(1500);
    }

    if (chatIdFromUrl(page.url()) !== chatId) {
      await page.goto(workerUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(1500);
    }
    const finalId = chatIdFromUrl(page.url());
    if (finalId !== chatId) {
      throw new Error(
        `Failed to bind ${workerId} to ${chatId} (page at ${page.url()})`
      );
    }

    // Re-check uniqueness after navigation (another bind may have claimed).
    const ownerAfter = this.chatOwners.get(chatId);
    if (ownerAfter && ownerAfter !== workerId) {
      throw new Error(
        `Duplicate chat binding after navigate: ${chatId} owned by ${ownerAfter}`
      );
    }

    const generation = (prev?.generation ?? 0) + 1;
    const browser = ChatGptBrowser.attachShared({
      browser: this.browser,
      context: this.context,
      page,
      workerUrl,
      chatGptUrl: this.options.chatGptUrl,
    });

    if (prev) {
      this.chatOwners.delete(prev.chatId);
    }

    const binding: BrokerWorkerBinding = {
      workerId,
      workerUrl,
      page,
      generation,
      connectionGeneration: this.connectionGeneration,
      chatId,
      browser,
    };
    this.bindings.set(workerId, binding);
    this.chatOwners.set(chatId, workerId);
    log({
      event: "INFO",
      component: "browser-broker",
      message: `Bound worker=${workerId} chat=${chatId} generation=${generation} connGen=${this.connectionGeneration}`,
    });
    return binding;
  }

  /**
   * Fail-closed page/chat/generation check immediately before irreversible write.
   */
  assertBindingFresh(workerId: string): BrokerWorkerBinding {
    if (!this.healthy) {
      throw new Error(`Broker CDP unhealthy — refuse UI write for ${workerId}`);
    }
    const b = this.getBinding(workerId);
    if (b.connectionGeneration !== this.connectionGeneration) {
      throw new Error(
        `Stale connection generation for ${workerId}: binding=${b.connectionGeneration} live=${this.connectionGeneration}`
      );
    }
    if (b.page.isClosed()) {
      throw new Error(`Page closed for worker ${workerId}`);
    }
    const current = chatIdFromUrl(b.page.url());
    if (current !== b.chatId) {
      throw new Error(
        `Binding drift for ${workerId}: expected chat ${b.chatId}, page at ${b.page.url()}`
      );
    }
    if (this.chatOwners.get(b.chatId) !== workerId) {
      throw new Error(
        `Chat ownership lost for ${workerId} chat=${b.chatId}`
      );
    }
    return b;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.healthy = false;
    this.bindings.clear();
    this.chatOwners.clear();
    try {
      await this.browser?.close();
    } catch {
      // disconnect only
    }
    this.browser = null;
    this.context = null;
  }
}
