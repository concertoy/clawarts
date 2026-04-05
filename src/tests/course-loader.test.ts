import { describe, it, expect } from "vitest";
import { parseCourseSchedule } from "../course-loader.js";

describe("parseCourseSchedule", () => {
  it("parses course title", () => {
    const result = parseCourseSchedule("# CS101 — Intro to Programming\n");
    expect(result.title).toBe("CS101 — Intro to Programming");
  });

  it("parses homework entries", () => {
    const md = [
      "# CS101",
      "## Week 1 (2026-09-07)",
      '- homework: "Variables" due 2026-09-14',
      "  > Write a program.",
    ].join("\n");
    const result = parseCourseSchedule(md);
    expect(result.homeworks).toHaveLength(1);
    expect(result.homeworks[0].title).toBe("Variables");
    expect(result.homeworks[0].deadline).toBe("2026-09-14");
    expect(result.homeworks[0].description).toBe("Write a program.");
    expect(result.homeworks[0].weekDate).toBe("2026-09-07");
  });

  it("parses checkin entries", () => {
    const md = [
      "# CS101",
      "## Week 1 (2026-09-07)",
      '- checkin: quiz topic="data types" duration=5',
    ].join("\n");
    const result = parseCourseSchedule(md);
    expect(result.checkins).toHaveLength(1);
    expect(result.checkins[0].mode).toBe("quiz");
    expect(result.checkins[0].topic).toBe("data types");
    expect(result.checkins[0].durationMinutes).toBe(5);
  });

  it("warns on homework without week context", () => {
    const md = '- homework: "Variables" due 2026-09-14\n';
    const result = parseCourseSchedule(md);
    expect(result.warnings.some((w) => w.includes("no week context"))).toBe(true);
  });

  it("does not match malformed deadline format", () => {
    // Regex requires YYYY-MM-DD, so "not-a-date" won't match the homework pattern at all
    const md = [
      "## Week 1 (2026-09-07)",
      '- homework: "Test" due not-a-date',
    ].join("\n");
    const result = parseCourseSchedule(md);
    expect(result.homeworks).toHaveLength(0); // line doesn't match homework regex
  });

  it("warns on unknown checkin mode", () => {
    const md = [
      "## Week 1 (2026-09-07)",
      '- checkin: unknown topic="test"',
    ].join("\n");
    const result = parseCourseSchedule(md);
    expect(result.warnings.some((w) => w.includes("unknown check-in mode"))).toBe(true);
    expect(result.checkins[0].mode).toBe("reflect"); // defaults to reflect
  });

  it("warns when no entries found", () => {
    const result = parseCourseSchedule("# Empty Course\n");
    expect(result.warnings.some((w) => w.includes("No homework or check-in entries found"))).toBe(true);
  });

  it("parses pulse checkin with count and interval", () => {
    const md = [
      "## Week 8 (2026-10-26)",
      '- checkin: pulse topic="recursion" count=3 interval=15',
    ].join("\n");
    const result = parseCourseSchedule(md);
    expect(result.checkins[0].pulseCount).toBe(3);
    expect(result.checkins[0].pulseIntervalMinutes).toBe(15);
  });
});
