import { describe, it, expect, beforeEach } from "vitest";
import { enqueueCommand, clearLane, getLaneDepth, getQueueStats, setLaneConcurrency } from "../queue/command-queue.js";

describe("command-queue", () => {
  // Use unique lane names per test to avoid cross-test interference
  let lane: string;
  let counter = 0;
  beforeEach(() => {
    lane = `test-lane-${++counter}-${Date.now()}`;
    setLaneConcurrency(lane, 1);
  });

  it("executes a queued task", async () => {
    const result = await enqueueCommand(lane, async () => 42);
    expect(result).toBe(42);
  });

  it("serializes tasks in lane with concurrency 1", async () => {
    const order: number[] = [];
    const p1 = enqueueCommand(lane, async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
      order.push(2);
    });
    const p2 = enqueueCommand(lane, async () => {
      order.push(3);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("clearLane rejects pending tasks", async () => {
    // Fill the lane with a blocking task
    const blocker = enqueueCommand(lane, async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    // Queue another that will be cleared
    const pending = enqueueCommand(lane, async () => "should not run");
    const cleared = clearLane(lane);
    expect(cleared).toBe(1);
    await expect(pending).rejects.toThrow("cleared");
    await blocker; // let blocker finish
  });

  it("getLaneDepth tracks active + queued", async () => {
    expect(getLaneDepth(lane)).toBe(0);
    const blocker = enqueueCommand(lane, async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // Let microtask queue flush so the drain pump starts
    await new Promise((r) => setTimeout(r, 5));
    expect(getLaneDepth(lane)).toBeGreaterThanOrEqual(1);
    await blocker;
  });

  it("getQueueStats returns stats", () => {
    const stats = getQueueStats();
    expect(stats).toHaveProperty("evictions");
    expect(stats).toHaveProperty("lanes");
    expect(Array.isArray(stats.lanes)).toBe(true);
  });
});
