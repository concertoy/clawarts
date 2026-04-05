import { describe, it, expect, vi, afterEach } from "vitest";
import { isQuietHours } from "../agent.js";

describe("isQuietHours", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false for invalid format", () => {
    expect(isQuietHours("not-a-range")).toBe(false);
    expect(isQuietHours("25:00-07:00")).toBe(false);
    expect(isQuietHours("")).toBe(false);
  });

  it("returns false for single digit hours", () => {
    // Must be HH:MM format
    expect(isQuietHours("9:00-17:00")).toBe(false);
  });

  it("detects normal daytime range", () => {
    // Mock to 14:30 local time
    vi.setSystemTime(new Date("2026-04-05T14:30:00"));
    expect(isQuietHours("09:00-17:00")).toBe(true);
    expect(isQuietHours("15:00-17:00")).toBe(false);
  });

  it("detects overnight range", () => {
    // Mock to 23:30 local time
    vi.setSystemTime(new Date("2026-04-05T23:30:00"));
    expect(isQuietHours("23:00-07:00")).toBe(true);
  });

  it("overnight range includes early morning", () => {
    // Mock to 02:00 local time
    vi.setSystemTime(new Date("2026-04-05T02:00:00"));
    expect(isQuietHours("23:00-07:00")).toBe(true);
  });

  it("overnight range excludes daytime", () => {
    // Mock to 12:00 local time
    vi.setSystemTime(new Date("2026-04-05T12:00:00"));
    expect(isQuietHours("23:00-07:00")).toBe(false);
  });

  it("boundary: start time is inclusive", () => {
    vi.setSystemTime(new Date("2026-04-05T09:00:00"));
    expect(isQuietHours("09:00-17:00")).toBe(true);
  });

  it("boundary: end time is exclusive", () => {
    vi.setSystemTime(new Date("2026-04-05T17:00:00"));
    expect(isQuietHours("09:00-17:00")).toBe(false);
  });

  it("respects timezone parameter", () => {
    // 2026-04-05T06:00:00Z = 14:00 in Asia/Hong_Kong (UTC+8), 23:00 in America/Los_Angeles (UTC-7)
    vi.setSystemTime(new Date("2026-04-05T06:00:00Z"));
    // 14:00 HKT — inside 13:00-15:00
    expect(isQuietHours("13:00-15:00", "Asia/Hong_Kong")).toBe(true);
    // 23:00 LA — outside 13:00-15:00
    expect(isQuietHours("13:00-15:00", "America/Los_Angeles")).toBe(false);
  });
});
