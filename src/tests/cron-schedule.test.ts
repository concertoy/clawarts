import { describe, it, expect } from "vitest";
import { computeNextRunAtMs } from "../cron/schedule.js";

describe("computeNextRunAtMs", () => {
  describe("at schedule", () => {
    it("returns atMs when in the future", () => {
      const result = computeNextRunAtMs({ kind: "at", atMs: 2000 }, 1000);
      expect(result).toBe(2000);
    });

    it("returns undefined when atMs is in the past", () => {
      const result = computeNextRunAtMs({ kind: "at", atMs: 500 }, 1000);
      expect(result).toBeUndefined();
    });

    it("returns undefined when atMs equals now", () => {
      const result = computeNextRunAtMs({ kind: "at", atMs: 1000 }, 1000);
      expect(result).toBeUndefined();
    });
  });

  describe("every schedule", () => {
    it("returns next interval after now", () => {
      const result = computeNextRunAtMs({ kind: "every", everyMs: 1000, anchorMs: 0 }, 2500);
      expect(result).toBe(3000);
    });

    it("returns anchor when now is before anchor", () => {
      const result = computeNextRunAtMs({ kind: "every", everyMs: 1000, anchorMs: 5000 }, 1000);
      expect(result).toBe(5000);
    });

    it("returns current interval at exact boundary", () => {
      // At exact boundary (elapsed=3000, everyMs=1000), steps=ceil(3000/1000)=3, next=3000
      const result = computeNextRunAtMs({ kind: "every", everyMs: 1000, anchorMs: 0 }, 3000);
      expect(result).toBe(3000);
    });

    it("uses now as anchor when anchorMs is not set", () => {
      const now = 10000;
      const result = computeNextRunAtMs({ kind: "every", everyMs: 5000 }, now);
      // With anchor=now, elapsed=0, steps=1, next = now + everyMs
      expect(result).toBe(now + 5000);
    });

    it("handles very small everyMs (clamped to 1ms)", () => {
      const result = computeNextRunAtMs({ kind: "every", everyMs: 0, anchorMs: 0 }, 100);
      expect(result).toBeGreaterThanOrEqual(100);
    });
  });
});
