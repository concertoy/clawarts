import { describe, it, expect } from "vitest";
import { withRetry } from "../utils/retry.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(async () => 42);
    expect(result).toBe(42);
  });

  it("retries on retriable error", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error("HTTP 429 rate limited");
      return "ok";
    }, { maxRetries: 5 });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("throws immediately on non-retriable error", async () => {
    await expect(
      withRetry(async () => { throw new Error("invalid input"); }, { maxRetries: 3 }),
    ).rejects.toThrow("invalid input");
  });

  it("throws after max retries exhausted", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error("HTTP 500 server error");
      }, { maxRetries: 2 }),
    ).rejects.toThrow("500");
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it("does not retry abort errors", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }, { maxRetries: 3 }),
    ).rejects.toThrow("aborted");
    expect(attempts).toBe(1);
  });

  it("retries on connection errors", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts === 1) throw new Error("ECONNRESET");
      return "recovered";
    }, { maxRetries: 2 });
    expect(result).toBe("recovered");
  });

  it("calls onRetry callback", async () => {
    const retries: number[] = [];
    let attempts = 0;
    await withRetry(async () => {
      attempts++;
      if (attempts < 2) throw new Error("503 Service Unavailable");
      return "ok";
    }, {
      maxRetries: 3,
      onRetry: (attempt) => retries.push(attempt),
    });
    expect(retries).toEqual([1]);
  });
});
