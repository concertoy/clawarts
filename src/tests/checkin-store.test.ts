import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CheckinStore } from "../store/checkin-store.js";

describe("CheckinStore", () => {
  let tmpDir: string;
  let store: CheckinStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawarts-checkin-test-"));
    store = new CheckinStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("window management", () => {
    it("creates a window", async () => {
      const w = await store.createWindow({
        tutorId: "tutor",
        mode: "quiz",
        topic: "variables",
        closesAt: Date.now() + 60000,
      });
      expect(w.id).toBeDefined();
      expect(w.status).toBe("open");
      expect(w.mode).toBe("quiz");
    });

    it("gets a window by id", async () => {
      const w = await store.createWindow({
        tutorId: "tutor",
        mode: "passphrase",
        passphrase: "hello123",
        closesAt: Date.now() + 60000,
      });
      const found = await store.getWindow(w.id);
      expect(found?.passphrase).toBe("hello123");
    });

    it("gets active window", async () => {
      await store.createWindow({
        tutorId: "tutor",
        mode: "quiz",
        closesAt: Date.now() + 60000,
      });
      const active = await store.getActiveWindow();
      expect(active).toBeDefined();
      expect(active!.status).toBe("open");
    });

    it("returns undefined when no active window", async () => {
      const active = await store.getActiveWindow();
      expect(active).toBeUndefined();
    });

    it("auto-closes expired windows on getActiveWindow", async () => {
      await store.createWindow({
        tutorId: "tutor",
        mode: "quiz",
        closesAt: Date.now() - 1000, // already expired
      });
      const active = await store.getActiveWindow();
      expect(active).toBeUndefined();
    });

    it("closes a window", async () => {
      const w = await store.createWindow({
        tutorId: "tutor",
        mode: "quiz",
        closesAt: Date.now() + 60000,
      });
      const closed = await store.closeWindow(w.id);
      expect(closed?.status).toBe("closed");
    });

    it("lists windows", async () => {
      await store.createWindow({ tutorId: "tutor", mode: "quiz", closesAt: Date.now() + 60000 });
      await store.createWindow({ tutorId: "tutor", mode: "reflect", closesAt: Date.now() + 60000 });
      const all = await store.listWindows();
      expect(all).toHaveLength(2);
    });

    it("filters by pulse group", async () => {
      await store.createWindow({ tutorId: "tutor", mode: "pulse", pulseGroupId: "g1", closesAt: Date.now() + 60000 });
      await store.createWindow({ tutorId: "tutor", mode: "pulse", pulseGroupId: "g2", closesAt: Date.now() + 60000 });
      const g1 = await store.listWindows({ pulseGroupId: "g1" });
      expect(g1).toHaveLength(1);
    });

    it("closeExpiredWindows returns count", async () => {
      await store.createWindow({ tutorId: "tutor", mode: "quiz", closesAt: Date.now() - 1000 });
      await store.createWindow({ tutorId: "tutor", mode: "quiz", closesAt: Date.now() + 60000 });
      const closed = await store.closeExpiredWindows();
      expect(closed).toBe(1);
    });
  });

  describe("response management", () => {
    let windowId: string;

    beforeEach(async () => {
      const w = await store.createWindow({
        tutorId: "tutor",
        mode: "quiz",
        closesAt: Date.now() + 60000,
      });
      windowId = w.id;
    });

    it("adds a response", async () => {
      const r = await store.addResponse({
        windowId,
        userId: "U123",
        agentId: "student-1",
        content: "My answer",
      });
      expect("error" in r).toBe(false);
      if (!("error" in r)) {
        expect(r.userId).toBe("U123");
        expect(r.submittedAt).toBeGreaterThan(0);
      }
    });

    it("rejects response for nonexistent window", async () => {
      const r = await store.addResponse({
        windowId: "bad-id",
        userId: "U123",
        agentId: "student-1",
        content: "answer",
      });
      expect("error" in r).toBe(true);
    });

    it("overwrites previous response from same user", async () => {
      await store.addResponse({ windowId, userId: "U123", agentId: "s1", content: "first" });
      await store.addResponse({ windowId, userId: "U123", agentId: "s1", content: "second" });
      const responses = await store.getResponsesByWindow(windowId);
      expect(responses).toHaveLength(1);
      expect(responses[0].content).toBe("second");
    });

    it("counts responses by window", async () => {
      await store.addResponse({ windowId, userId: "U1", agentId: "s1", content: "a" });
      await store.addResponse({ windowId, userId: "U2", agentId: "s2", content: "b" });
      const counts = await store.countByWindow(windowId);
      expect(counts.total).toBe(2);
      expect(counts.evaluated).toBe(0);
    });

    it("gets response by window and user", async () => {
      await store.addResponse({ windowId, userId: "U123", agentId: "s1", content: "answer" });
      const r = await store.getResponseByWindowAndUser(windowId, "U123");
      expect(r?.content).toBe("answer");
    });
  });

  describe("evaluation", () => {
    it("evaluates a response", async () => {
      const w = await store.createWindow({ tutorId: "tutor", mode: "quiz", closesAt: Date.now() + 60000 });
      const r = await store.addResponse({ windowId: w.id, userId: "U1", agentId: "s1", content: "answer" });
      if ("error" in r) throw new Error("unexpected");
      const evaluated = await store.evaluateResponse(r.id, { score: 90, status: "checked_in", feedback: "Nice!" });
      expect(evaluated?.score).toBe(90);
      expect(evaluated?.feedback).toBe("Nice!");
      expect(evaluated?.evaluatedAt).toBeGreaterThan(0);
    });

    it("bulk evaluates responses", async () => {
      const w = await store.createWindow({ tutorId: "tutor", mode: "quiz", closesAt: Date.now() + 60000 });
      const r1 = await store.addResponse({ windowId: w.id, userId: "U1", agentId: "s1", content: "a" });
      const r2 = await store.addResponse({ windowId: w.id, userId: "U2", agentId: "s2", content: "b" });
      if ("error" in r1 || "error" in r2) throw new Error("unexpected");
      const count = await store.bulkEvaluate([
        { responseId: r1.id, score: 80, status: "checked_in" },
        { responseId: r2.id, score: 95, status: "checked_in", feedback: "Excellent" },
      ]);
      expect(count).toBe(2);
    });

    it("counts user stats with average score", async () => {
      const w = await store.createWindow({ tutorId: "tutor", mode: "quiz", closesAt: Date.now() + 60000 });
      const r1 = await store.addResponse({ windowId: w.id, userId: "U1", agentId: "s1", content: "a" });
      if ("error" in r1) throw new Error("unexpected");
      await store.evaluateResponse(r1.id, { score: 80, status: "checked_in" });
      const stats = await store.countByUser("U1");
      expect(stats.responded).toBe(1);
      expect(stats.avgScore).toBe(80);
    });
  });
});
