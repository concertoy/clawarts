import { describe, it, expect } from "vitest";
import { computeNextRunAtMs } from "../cron/schedule.js";

describe("computeNextRunAtMs", () => {
  describe("kind: at", () => {
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

  describe("kind: every", () => {
    it("computes next tick from anchor", () => {
      // Anchor at 0, every 1000ms, now at 500 → next at 1000
      const result = computeNextRunAtMs(
        { kind: "every", everyMs: 1000, anchorMs: 0 },
        500,
      );
      expect(result).toBe(1000);
    });

    it("returns anchor when now is before anchor", () => {
      const result = computeNextRunAtMs(
        { kind: "every", everyMs: 1000, anchorMs: 5000 },
        1000,
      );
      expect(result).toBe(5000);
    });

    it("defaults anchor to nowMs when not set", () => {
      const result = computeNextRunAtMs(
        { kind: "every", everyMs: 60000 },
        1000,
      );
      // anchor defaults to 1000 (nowMs), next run = 1000 + 60000
      expect(result).toBe(61000);
    });

    it("handles anchorMs of 0 correctly (does not default)", () => {
      const result = computeNextRunAtMs(
        { kind: "every", everyMs: 1000, anchorMs: 0 },
        2500,
      );
      // anchor=0, everyMs=1000, now=2500 → steps=3, next=3000
      expect(result).toBe(3000);
    });
  });
});
