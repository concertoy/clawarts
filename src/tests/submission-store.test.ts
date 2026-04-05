import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SubmissionStore } from "../store/submission-store.js";

describe("SubmissionStore", () => {
  let tmpDir: string;
  let store: SubmissionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawarts-submit-test-"));
    store = new SubmissionStore(path.join(tmpDir, "submissions.json"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseData = {
    assignmentId: "hw1",
    userId: "U123",
    agentId: "student-1",
    content: "My answer",
  };

  it("creates a submission", async () => {
    const s = await store.submit(baseData, Date.now() + 86400000);
    expect(s.id).toBeDefined();
    expect(s.status).toBe("submitted");
    expect(s.submittedAt).toBeGreaterThan(0);
  });

  it("marks late submissions", async () => {
    const s = await store.submit(baseData, Date.now() - 1000);
    expect(s.status).toBe("late");
  });

  it("overwrites previous submission from same user", async () => {
    await store.submit(baseData, Date.now() + 86400000);
    const s2 = await store.submit({ ...baseData, content: "Updated answer" }, Date.now() + 86400000);
    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("Updated answer");
    expect(all[0].id).toBe(s2.id);
  });

  it("lists by assignment", async () => {
    await store.submit(baseData, Date.now() + 86400000);
    await store.submit({ ...baseData, userId: "U456", assignmentId: "hw2" }, Date.now() + 86400000);
    const hw1 = await store.listByAssignment("hw1");
    expect(hw1).toHaveLength(1);
  });

  it("lists by user", async () => {
    await store.submit(baseData, Date.now() + 86400000);
    await store.submit({ ...baseData, assignmentId: "hw2" }, Date.now() + 86400000);
    const user = await store.listByUser("U123");
    expect(user).toHaveLength(2);
  });

  it("gets by assignment and user", async () => {
    await store.submit(baseData, Date.now() + 86400000);
    const found = await store.getByAssignmentAndUser("hw1", "U123");
    expect(found?.content).toBe("My answer");
  });

  it("returns undefined for missing submission", async () => {
    expect(await store.getByAssignmentAndUser("nope", "U123")).toBeUndefined();
  });

  it("grades a submission", async () => {
    const s = await store.submit(baseData, Date.now() + 86400000);
    const graded = await store.grade(s.id, 85, "Good work!");
    expect(graded?.score).toBe(85);
    expect(graded?.feedback).toBe("Good work!");
    expect(graded?.gradedAt).toBeGreaterThan(0);
  });

  it("rejects invalid deadline timestamps", async () => {
    await expect(store.submit(baseData, 0)).rejects.toThrow("Invalid deadline timestamp");
    await expect(store.submit(baseData, 999999999)).rejects.toThrow("Invalid deadline timestamp"); // seconds, not ms
  });

  it("counts by assignment", async () => {
    await store.submit(baseData, Date.now() + 86400000);
    await store.submit({ ...baseData, userId: "U456" }, Date.now() - 1000); // late
    const counts = await store.countByAssignment("hw1");
    expect(counts.total).toBe(2);
    expect(counts.late).toBe(1);
  });
});
