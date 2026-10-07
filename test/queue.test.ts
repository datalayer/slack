import { describe, expect, it, vi } from "vitest";

import { MemoryWorkQueue } from "../src/queue.js";

describe("MemoryWorkQueue", () => {
  it("acknowledges enqueue before slow work finishes", async () => {
    const queue = new MemoryWorkQueue<number>();
    let release: (() => void) | undefined;
    const handled = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    queue.start(handled);
    await queue.enqueue(1);
    await vi.waitFor(() => expect(handled).toHaveBeenCalledWith(1));
    release?.();
    await queue.stop();
  });
});
