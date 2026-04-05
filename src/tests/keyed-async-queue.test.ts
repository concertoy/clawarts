import { describe, it, expect } from "vitest";
import { KeyedAsyncQueue } from "../queue/keyed-async-queue.js";

describe("KeyedAsyncQueue", () => {
  it("executes a single task", async () => {
    const q = new KeyedAsyncQueue();
    const result = await q.enqueue("k", async () => 42);
    expect(result).toBe(42);
  });

  it("serializes tasks for the same key", async () => {
    const q = new KeyedAsyncQueue();
    const order: number[] = [];
    const p1 = q.enqueue("k", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
      order.push(2);
    });
    const p2 = q.enqueue("k", async () => {
      order.push(3);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("runs different keys concurrently", async () => {
    const q = new KeyedAsyncQueue();
    const order: string[] = [];
    const p1 = q.enqueue("a", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    });
    const p2 = q.enqueue("b", async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([p1, p2]);
    // b should complete before a ends
    expect(order.indexOf("b-end")).toBeLessThan(order.indexOf("a-end"));
  });

  it("continues chain after error", async () => {
    const q = new KeyedAsyncQueue();
    const p1 = q.enqueue("k", async () => { throw new Error("fail"); });
    await p1.catch(() => {});
    const result = await q.enqueue("k", async () => "ok");
    expect(result).toBe("ok");
  });

  it("tracks active keys via has/size", async () => {
    const q = new KeyedAsyncQueue();
    expect(q.size).toBe(0);
    expect(q.has("k")).toBe(false);

    let resolve!: () => void;
    const blocker = new Promise<void>((r) => { resolve = r; });
    const p = q.enqueue("k", () => blocker);
    expect(q.has("k")).toBe(true);
    expect(q.size).toBe(1);

    resolve();
    await p;
    // After completion, key should be cleaned up
    // (may need a microtask tick for cleanup)
    await new Promise((r) => setTimeout(r, 0));
    expect(q.has("k")).toBe(false);
  });
});
