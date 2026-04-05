import { describe, it, expect } from "vitest";
import { computeAbsentUsers, computeAverageScore, autoEvaluatePassphrase } from "../tools/checkin-notify.js";

describe("computeAbsentUsers", () => {
  it("returns users who did not respond", () => {
    const absent = computeAbsentUsers(
      ["U1", "U2", "U3"],
      [{ userId: "U1" }, { userId: "U3" }],
    );
    expect(absent).toEqual(["U2"]);
  });

  it("returns all users when no responses", () => {
    expect(computeAbsentUsers(["U1", "U2"], [])).toEqual(["U1", "U2"]);
  });

  it("returns empty when all responded", () => {
    expect(computeAbsentUsers(["U1"], [{ userId: "U1" }])).toEqual([]);
  });
});

describe("computeAverageScore", () => {
  it("computes average of scored responses", () => {
    expect(computeAverageScore([{ score: 80 }, { score: 100 }])).toBe(90);
  });

  it("returns null when no scores", () => {
    expect(computeAverageScore([{ score: null }, {}])).toBeNull();
  });

  it("ignores unscored responses", () => {
    expect(computeAverageScore([{ score: 60 }, { score: null }, {}])).toBe(60);
  });

  it("rounds to nearest integer", () => {
    expect(computeAverageScore([{ score: 33 }, { score: 33 }, { score: 34 }])).toBe(33);
  });
});

describe("autoEvaluatePassphrase", () => {
  it("marks correct passphrase as checked_in with 100", () => {
    const results = autoEvaluatePassphrase(
      [{ id: "r1", content: "secret123" }],
      "secret123",
    );
    expect(results[0].score).toBe(100);
    expect(results[0].status).toBe("checked_in");
  });

  it("marks incorrect passphrase as needs_review with 0", () => {
    const results = autoEvaluatePassphrase(
      [{ id: "r1", content: "wrong" }],
      "secret123",
    );
    expect(results[0].score).toBe(0);
    expect(results[0].status).toBe("needs_review");
    expect(results[0].feedback).toContain("secret123");
  });

  it("is case-insensitive", () => {
    const results = autoEvaluatePassphrase(
      [{ id: "r1", content: "SECRET123" }],
      "secret123",
    );
    expect(results[0].score).toBe(100);
  });

  it("trims whitespace", () => {
    const results = autoEvaluatePassphrase(
      [{ id: "r1", content: "  secret123  " }],
      "secret123",
    );
    expect(results[0].score).toBe(100);
  });

  it("evaluates multiple responses", () => {
    const results = autoEvaluatePassphrase(
      [
        { id: "r1", content: "secret123" },
        { id: "r2", content: "wrong" },
        { id: "r3", content: "Secret123" },
      ],
      "secret123",
    );
    expect(results.filter((r) => r.score === 100)).toHaveLength(2);
    expect(results.filter((r) => r.score === 0)).toHaveLength(1);
  });
});
