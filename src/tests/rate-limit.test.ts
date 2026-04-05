import { describe, it, expect } from "vitest";
import { createRateLimiter } from "../utils/rate-limit.js";

describe("createRateLimiter", () => {
  it("allows requests within limit", () => {
    const limiter = createRateLimiter({ maxRequests: 3, windowMs: 1000 });
    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(true);
  });

  it("rejects requests over limit", () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 1000 });
    limiter.consume();
    limiter.consume();
    const result = limiter.consume();
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets after window expires", () => {
    let now = 1000;
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowMs: 100,
      now: () => now,
    });
    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(false);
    now = 1200; // advance past window
    expect(limiter.consume().allowed).toBe(true);
  });

  it("tracks remaining count", () => {
    const limiter = createRateLimiter({ maxRequests: 3, windowMs: 1000 });
    expect(limiter.consume().remaining).toBe(2);
    expect(limiter.consume().remaining).toBe(1);
    expect(limiter.consume().remaining).toBe(0);
  });

  it("tracks stats", () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000 });
    limiter.consume();
    limiter.consume();
    const stats = limiter.stats();
    expect(stats.accepted).toBe(1);
    expect(stats.rejected).toBe(1);
  });

  it("resets state", () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000 });
    limiter.consume();
    expect(limiter.consume().allowed).toBe(false);
    limiter.reset();
    expect(limiter.consume().allowed).toBe(true);
  });
});
