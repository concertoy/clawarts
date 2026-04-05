import { describe, it, expect } from "vitest";
import { runWithConcurrency } from "../utils/concurrency.js";

describe("runWithConcurrency", () => {
  it("returns empty for empty input", async () => {
    const results = await runWithConcurrency([], async () => 1, 5);
    expect(results).toEqual([]);
  });

  it("processes all items", async () => {
    const results = await runWithConcurrency([1, 2, 3], async (n) => n * 2, 2);
    expect(results.map((r) => r.status === "fulfilled" ? r.value : null)).toEqual([2, 4, 6]);
  });

  it("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await runWithConcurrency(
      [1, 2, 3, 4, 5],
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return maxActive;
      },
      2,
    );
    // All should succeed
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("continues on individual failure", async () => {
    const results = await runWithConcurrency(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error("fail");
        return n;
      },
      3,
    );
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("clamps limit to item count", async () => {
    let maxActive = 0;
    let active = 0;
    await runWithConcurrency(
      [1, 2],
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
      100, // way more than items
    );
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
