export interface WorkQueue<T> {
  /**
   * Persist one job. With an idempotency key (a Slack event or action id),
   * the key and the job are kept in one transaction and a second job under
   * the same key is not enqueued: `false`.
   */
  enqueue(item: T, idempotencyKey?: string): Promise<boolean>;
  /** Whether the queue can take durable work now: what readiness reports. */
  ready(): Promise<boolean>;
  start(handler: (item: T) => Promise<void>): void;
  stop(): Promise<void>;
}

/** In-process development queue. A durable adapter is required in production. */
export class MemoryWorkQueue<T> implements WorkQueue<T> {
  readonly #items: T[] = [];
  readonly #keys = new Set<string>();
  #handler?: (item: T) => Promise<void>;
  #running = false;

  async enqueue(item: T, idempotencyKey?: string): Promise<boolean> {
    if (idempotencyKey) {
      if (this.#keys.has(idempotencyKey)) return false;
      this.#keys.add(idempotencyKey);
    }
    this.#items.push(item);
    queueMicrotask(() => void this.#drain());
    return true;
  }

  async ready(): Promise<boolean> {
    return true;
  }

  start(handler: (item: T) => Promise<void>): void {
    this.#handler = handler;
    void this.#drain();
  }

  async stop(): Promise<void> {
    this.#handler = undefined;
    while (this.#running)
      await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async #drain(): Promise<void> {
    if (this.#running || !this.#handler) return;
    this.#running = true;
    try {
      while (this.#items.length > 0) {
        const handler = this.#handler;
        if (!handler) break;
        const item = this.#items.shift();
        if (item !== undefined) await handler(item);
      }
    } finally {
      this.#running = false;
    }
  }
}
