/**
 * Narrow async mutex for A1-S irreversible UI writes (assert + type/send only).
 * Must NOT be held across ChatGPT wait / MCP / lease renew / CAS markers.
 */
export class UiWriteMutex {
  private chain: Promise<void> = Promise.resolve();
  private held = false;
  private holdStartedAt = 0;

  get isHeld(): boolean {
    return this.held;
  }

  /** Milliseconds current holder has held the lock (0 if free). */
  holdDurationMs(): number {
    return this.held ? Date.now() - this.holdStartedAt : 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.chain;
    // Swallow prior rejection so one failed critical section cannot poison the queue.
    this.chain = prev.then(
      () => gate,
      () => gate
    );
    await prev.then(
      () => undefined,
      () => undefined
    );
    this.held = true;
    this.holdStartedAt = Date.now();
    try {
      return await fn();
    } finally {
      this.held = false;
      this.holdStartedAt = 0;
      release();
    }
  }
}
