/**
 * Per-key serialization with cross-key concurrency.
 * Each key gets its own serial queue, but unrelated keys run in parallel.
 * Ported from OpenClaw's plugin-sdk/keyed-async-queue.ts.
 */
export class KeyedAsyncQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Enqueue a task for the given key.
   * If another task is running for the same key, this waits for it to finish.
   * Tasks for different keys run concurrently.
   */
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    // Chain off the previous tail for this key
    const previous = this.tails.get(key) ?? Promise.resolve();

    const current = previous
      .catch(() => undefined) // Swallow previous errors so chain doesn't break
      .then(task);

    // Keep a void tail promise (excludes task result for memory efficiency)
    const tail = current.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(key, tail);

    // Auto-cleanup when tail completes and no new tail was added
    void tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return current;
  }

  /** Number of keys with active/pending work. */
  get size(): number {
    return this.tails.size;
  }
}
