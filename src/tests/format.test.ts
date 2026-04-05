import { describe, it, expect } from "vitest";
import { formatTokenCount, formatUsd, formatDuration, formatTimeAgo } from "../utils/format.js";

describe("formatTokenCount", () => {
  it("formats millions", () => {
    expect(formatTokenCount(2_500_000)).toBe("2.5m");
  });
  it("formats thousands", () => {
    expect(formatTokenCount(1_200)).toBe("1.2k");
  });
  it("rounds for 10K+", () => {
    expect(formatTokenCount(12_345)).toBe("12k");
  });
  it("formats small values", () => {
    expect(formatTokenCount(42)).toBe("42");
  });
  it("handles undefined", () => {
    expect(formatTokenCount(undefined)).toBe("0");
  });
  it("handles NaN", () => {
    expect(formatTokenCount(NaN)).toBe("0");
  });
});

describe("formatUsd", () => {
  it("formats normal values", () => {
    expect(formatUsd(1.5)).toBe("$1.50");
  });
  it("formats tiny values with 4 decimals", () => {
    expect(formatUsd(0.003)).toBe("$0.0030");
  });
});

describe("formatDuration", () => {
  it("formats days", () => {
    expect(formatDuration(86_400_000)).toBe("1.0d");
  });
  it("formats hours", () => {
    expect(formatDuration(3_600_000)).toBe("1.0h");
  });
  it("formats minutes", () => {
    expect(formatDuration(90_000)).toBe("1.5m");
  });
  it("formats seconds", () => {
    expect(formatDuration(5_000)).toBe("5.0s");
  });
  it("handles invalid input", () => {
    expect(formatDuration(-1)).toBe("?");
    expect(formatDuration(Infinity)).toBe("?");
  });
});

describe("formatTimeAgo", () => {
  it("handles undefined", () => {
    expect(formatTimeAgo(undefined)).toBe("never");
  });
  it("handles recent", () => {
    expect(formatTimeAgo(Date.now())).toBe("just now");
  });
  it("handles minutes ago", () => {
    expect(formatTimeAgo(Date.now() - 5 * 60_000)).toBe("5m ago");
  });
});
