import type { Browser, BrowserContext, Page } from "playwright";
import { ChatGptBrowser } from "./chatgpt.js";
import { createWorkerChatOnContext, completeWorkerChatOnPage } from "./create-chat.js";
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
  /** Wall clock when this binding was last established. */
  boundAt: number;
}

export interface BrowserBrokerWorkerSpec {
  id: string;
  workerUrl?: string;
}

export interface BrowserBrokerOptions {
  cdpEndpoint: string;
  chatGptUrl: string;
  workers: BrowserBrokerWorkerSpec[];
  /** All registry ids (for status unbound detection). */
  registryWorkerIds?: string[];
}

export interface BrokerStatusSnapshot {
  healthy: boolean;
  cdpEndpoint: string;
  connectionGeneration: number;
  registryWorkerIds: string[];
  bindings: Array<{
    workerId: string;
    chatId: string;
    pageUrl: string;
    generation: number;
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function bindGraceMs(): number {
  const n = Number(process.env.HANDOFF_BIND_GRACE_MS ?? 60_000);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

function safePageUrl(page: Page): string | null {
  try {
    if (page.isClosed()) return null;
    return page.url();
  } catch {
    return null;
  }
}

function pageMatchesChat(page: Page, chatId: string): boolean {
  const url = safePageUrl(page);
  if (!url) return false;
  return chatIdFromUrl(url) === chatId;
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
  /** In-flight create-chat automation per worker — abort on cancel/disable. */
  private readonly uiAbortByWorker = new Map<string, AbortController>();
  private bindingChangedHandler: ((workerId: string) => void) | null = null;

  onBindingChanged(handler: (workerId: string) => void): void {
    this.bindingChangedHandler = handler;
  }

  private notifyBindingChanged(workerId: string): void {
    this.bindingChangedHandler?.(workerId);
  }

  constructor(private readonly options: BrowserBrokerOptions) {
    if (options.workers.length < 1) {
      throw new Error("BrowserBroker requires at least one worker entry");
    }
    const ids = new Set(options.workers.map((w) => w.id));
    if (ids.size !== options.workers.length) {
      throw new Error("BrowserBroker worker ids must be unique");
    }
    const withUrl = options.workers.filter(
      (w) => w.workerUrl && chatIdFromUrl(w.workerUrl)
    );
    const urls = new Set(withUrl.map((w) => w.workerUrl!));
    if (urls.size !== withUrl.length) {
      throw new Error("BrowserBroker worker URLs must be unique");
    }
    const chatIds = withUrl.map((w) => chatIdFromUrl(w.workerUrl!)!);
    if (new Set(chatIds).size !== chatIds.length) {
      throw new Error("BrowserBroker chat ids must be unique");
    }
  }

  getCdpEndpoint(): string {
    return this.options.cdpEndpoint;
  }

  getContext(): BrowserContext | null {
    return this.context;
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

    let bound = 0;
    for (const w of this.options.workers) {
      if (!w.workerUrl || !chatIdFromUrl(w.workerUrl)) continue;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.bindWorkerLocked(w.id, w.workerUrl);
          bound += 1;
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt >= 3) {
            log({
              event: "WARN",
              component: "browser-broker",
              message: `Bind failed worker=${w.id}: ${message}`,
            });
          } else {
            log({
              event: "WARN",
              component: "browser-broker",
              message: `Bind retry ${attempt} worker=${w.id}: ${message}`,
            });
            await sleep(1500 * attempt);
          }
        }
      }
    }

    this.healthy = true;
    this.browser.on("disconnected", () => {
      void this.handleDisconnect();
    });

    log({
      event: "INFO",
      component: "browser-broker",
      message: `Broker ready cdp=${this.options.cdpEndpoint} gen=${this.connectionGeneration} bound=${bound} workers=[${[...this.bindings.keys()].join(",")}]`,
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

  hasBinding(workerId: string): boolean {
    return this.bindings.has(workerId);
  }

  listBindings(): BrokerWorkerBinding[] {
    return [...this.bindings.values()];
  }

  getStatusSnapshot(): BrokerStatusSnapshot {
    return {
      healthy: this.isHealthy(),
      cdpEndpoint: this.options.cdpEndpoint,
      connectionGeneration: this.connectionGeneration,
      registryWorkerIds:
        this.options.registryWorkerIds ??
        this.options.workers.map((w) => w.id),
      bindings: this.listBindings().flatMap((b) => {
        const pageUrl = safePageUrl(b.page);
        if (!pageUrl) return [];
        return [
          {
            workerId: b.workerId,
            chatId: b.chatId,
            pageUrl,
            generation: b.generation,
          },
        ];
      }),
    };
  }

  private workerSpec(workerId: string): BrowserBrokerWorkerSpec | undefined {
    return this.options.workers.find((w) => w.id === workerId);
  }

  async bindWorker(
    workerId: string,
    workerUrl: string
  ): Promise<BrokerWorkerBinding> {
    return this.withBindLock(() => this.bindWorkerLocked(workerId, workerUrl));
  }

  async rebindWorker(
    workerId: string,
    workerUrl: string
  ): Promise<BrokerWorkerBinding> {
    return this.withBindLock(async () => {
      const prev = this.bindings.get(workerId);
      const newChat = chatIdFromUrl(workerUrl);
      if (!newChat) throw new Error(`Invalid workerUrl: ${workerUrl}`);
      if (prev && chatIdFromUrl(prev.workerUrl) === newChat) {
        return prev;
      }
      if (prev) {
        this.chatOwners.delete(prev.chatId);
        this.bindings.delete(workerId);
        if (!prev.page.isClosed()) {
          await prev.page.close().catch(() => undefined);
        }
      }
      return this.bindWorkerLocked(workerId, workerUrl);
    });
  }

  async unbindWorker(workerId: string): Promise<void> {
    await this.withBindLock(async () => {
      const prev = this.bindings.get(workerId);
      if (!prev) return;
      this.chatOwners.delete(prev.chatId);
      this.bindings.delete(workerId);
      if (!prev.page.isClosed()) {
        await prev.page.close().catch(() => undefined);
      }
      log({
        event: "INFO",
        component: "browser-broker",
        message: `Unbound worker=${workerId}`,
      });
      this.notifyBindingChanged(workerId);
    });
  }

  /** Drop bindings whose tab left /c/<id> (e.g. navigated to home). */
  async pruneDriftedBindings(opts?: { autoRebind?: boolean }): Promise<void> {
    const grace = bindGraceMs();
    const now = Date.now();
    const drifted: string[] = [];
    for (const b of this.bindings.values()) {
      if (now - b.boundAt < grace) continue;
      if (b.page.isClosed() || !pageMatchesChat(b.page, b.chatId)) {
        drifted.push(b.workerId);
      }
    }
    for (const workerId of drifted) {
      const b = this.bindings.get(workerId);
      const spec = this.workerSpec(workerId);
      log({
        event: "WARN",
        component: "browser-broker",
        message: `Pruning drifted binding worker=${workerId} chat=${b?.chatId ?? "?"} page=${b ? safePageUrl(b.page) ?? "closed" : "closed"}`,
      });
      await this.unbindWorker(workerId);
      if (opts?.autoRebind !== false && spec?.workerUrl) {
        try {
          await this.bindWorker(workerId, spec.workerUrl);
          log({
            event: "INFO",
            component: "browser-broker",
            message: `Auto-rebound worker=${workerId} after drift prune`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log({
            event: "WARN",
            component: "browser-broker",
            message: `Auto-rebind failed worker=${workerId}: ${message}`,
          });
        }
      }
    }
  }

  /** Bind registry workers that have a URL but no live tab binding. */
  async healUnboundWorkers(): Promise<number> {
    let healed = 0;
    for (const w of this.options.workers) {
      if (!w.workerUrl || !chatIdFromUrl(w.workerUrl)) continue;
      if (this.hasBinding(w.id)) continue;
      try {
        await this.bindWorker(w.id, w.workerUrl);
        healed += 1;
        log({
          event: "INFO",
          component: "browser-broker",
          message: `Healed unbound worker=${w.id}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log({
          event: "WARN",
          component: "browser-broker",
          message: `Heal bind failed worker=${w.id}: ${message}`,
        });
      }
    }
    return healed;
  }

  async reconcileBindings(): Promise<void> {
    await this.pruneDriftedBindings({ autoRebind: true });
    await this.healUnboundWorkers();
  }

  cancelWorkerUi(workerId: string): void {
    const ctrl = this.uiAbortByWorker.get(workerId);
    if (ctrl) {
      ctrl.abort();
      this.uiAbortByWorker.delete(workerId);
      log({
        event: "INFO",
        component: "browser-broker",
        message: `Cancelled in-flight UI work worker=${workerId}`,
      });
    }
    this.notifyBindingChanged(workerId);
  }

  /** In-flight create-chat per worker — dedupe concurrent HTTP + reconciler retries. */
  private readonly createChatInFlight = new Map<
    string,
    Promise<{ workerUrl: string; chatId: string }>
  >();

  async createChatForWorker(
    workerId: string,
    bootstrapMessage?: string
  ): Promise<{ workerUrl: string; chatId: string }> {
    const existing = this.createChatInFlight.get(workerId);
    if (existing) {
      log({
        event: "INFO",
        component: "browser-broker",
        message: `create-chat already in flight for ${workerId} — awaiting`,
      });
      return existing;
    }
    const run = this.createChatForWorkerInner(workerId, bootstrapMessage).finally(
      () => {
        if (this.createChatInFlight.get(workerId) === run) {
          this.createChatInFlight.delete(workerId);
        }
      }
    );
    this.createChatInFlight.set(workerId, run);
    return run;
  }

  private async createChatForWorkerInner(
    workerId: string,
    bootstrapMessage?: string
  ): Promise<{ workerUrl: string; chatId: string }> {
    if (!this.context) throw new Error("Broker not connected");
    const ctrl = new AbortController();
    this.uiAbortByWorker.set(workerId, ctrl);
    const page = await this.context.newPage();
    try {
      const created = await this.uiWriteMutex.run(async () => {
        return await completeWorkerChatOnPage(page, {
          chatGptUrl: this.options.chatGptUrl,
          bootstrapMessage,
          signal: ctrl.signal,
        });
      });
      await this.withBindLock(async () => {
        await this.bindWorkerLocked(workerId, created.workerUrl);
      });
      return { workerUrl: created.workerUrl, chatId: created.chatId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!page.isClosed()) {
        log({
          event: "WARN",
          component: "browser-broker",
          message: `create-chat failed — tab left open for manual setup worker=${workerId}: ${message}`,
          data: { workerId },
        });
      }
      throw err;
    } finally {
      if (this.uiAbortByWorker.get(workerId) === ctrl) {
        this.uiAbortByWorker.delete(workerId);
      }
    }
  }

  async probeSession(workerId: string): Promise<{ ready: boolean; reason?: string }> {
    try {
      const b = this.getBinding(workerId);
      if (await b.browser.detectChatAccessDenied()) {
        return {
          ready: false,
          reason: "CHAT_ACCESS_DENIED: use Assign URL with a chat from CDP Chrome",
        };
      }
      const ready = await b.browser.ensureSessionReady();
      return { ready };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ready: false, reason: message };
    }
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
      boundAt: Date.now(),
    };
    this.bindings.set(workerId, binding);
    this.chatOwners.set(chatId, workerId);
    log({
      event: "INFO",
      component: "browser-broker",
      message: `Bound worker=${workerId} chat=${chatId} generation=${generation} connGen=${this.connectionGeneration}`,
    });
    this.notifyBindingChanged(workerId);
    return binding;
  }

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
    if (!pageMatchesChat(b.page, b.chatId)) {
      throw new Error(
        `Binding drift for ${workerId}: expected chat ${b.chatId}, page at ${safePageUrl(b.page) ?? "closed"}`
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
