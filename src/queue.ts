export interface WorkQueue<T> {
  enqueue(item: T): Promise<void>;
  start(handler: (item: T) => Promise<void>): void;
  stop(): Promise<void>;
}

/** In-process development queue. A durable adapter is required in production. */
export class MemoryWorkQueue<T> implements WorkQueue<T> {
  readonly #items: T[] = [];
  #handler?: (item: T) => Promise<void>;
  #running = false;

  async enqueue(item: T): Promise<void> {
    this.#items.push(item);
    queueMicrotask(() => void this.#drain());
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
