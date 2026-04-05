import { describe, it, expect } from "vitest";
import { formatTokenCount, formatDuration, formatTimeAgo } from "../utils/format.js";

describe("formatTokenCount", () => {
  it("handles undefined and NaN", () => {
    expect(formatTokenCount(undefined)).toBe("0");
    expect(formatTokenCount(NaN)).toBe("0");
    expect(formatTokenCount(-100)).toBe("0");
  });
});

describe("formatDuration", () => {
  it("handles invalid input", () => {
    expect(formatDuration(-1)).toBe("?");
    expect(formatDuration(Infinity)).toBe("?");
  });
});

describe("formatTimeAgo", () => {
  it("handles undefined and zero", () => {
    expect(formatTimeAgo(undefined)).toBe("never");
    expect(formatTimeAgo(0)).toBe("never");
  });
  it("handles future timestamps gracefully", () => {
    expect(formatTimeAgo(Date.now() + 60_000)).toBe("just now");
  });
  it("handles NaN and Infinity", () => {
    expect(formatTimeAgo(NaN)).toBe("never");
    expect(formatTimeAgo(Infinity)).toBe("never");
  });
});
