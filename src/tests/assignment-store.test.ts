import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AssignmentStore } from "../store/assignment-store.js";

describe("AssignmentStore", () => {
  let tmpDir: string;
  let store: AssignmentStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawarts-assign-test-"));
    store = new AssignmentStore(path.join(tmpDir, "assignments.json"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates an assignment", async () => {
    const a = await store.create({
      title: "HW1",
      description: "First homework",
      deadline: Date.now() + 86400000,
      format: "individual",
      attachments: [],
      status: "open",
      createdBy: "tutor",
    });
    expect(a.id).toBeDefined();
    expect(a.title).toBe("HW1");
    expect(a.createdAt).toBeGreaterThan(0);
  });

  it("lists all assignments", async () => {
    await store.create({ title: "A", description: "", deadline: 0, format: "individual", attachments: [], status: "open", createdBy: "t" });
    await store.create({ title: "B", description: "", deadline: 0, format: "individual", attachments: [], status: "closed", createdBy: "t" });
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it("filters by status", async () => {
    await store.create({ title: "A", description: "", deadline: 0, format: "individual", attachments: [], status: "open", createdBy: "t" });
    await store.create({ title: "B", description: "", deadline: 0, format: "individual", attachments: [], status: "closed", createdBy: "t" });
    const open = await store.list({ status: "open" });
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe("A");
  });

  it("gets assignment by id", async () => {
    const created = await store.create({ title: "C", description: "", deadline: 0, format: "individual", attachments: [], status: "open", createdBy: "t" });
    const found = await store.get(created.id);
    expect(found?.title).toBe("C");
  });

  it("returns undefined for missing id", async () => {
    expect(await store.get("nonexistent")).toBeUndefined();
  });

  it("updates an assignment", async () => {
    const a = await store.create({ title: "D", description: "", deadline: 0, format: "individual", attachments: [], status: "open", createdBy: "t" });
    const updated = await store.update(a.id, { title: "D-updated" });
    expect(updated?.title).toBe("D-updated");
  });

  it("closes an assignment", async () => {
    const a = await store.create({ title: "E", description: "", deadline: 0, format: "individual", attachments: [], status: "open", createdBy: "t" });
    const closed = await store.close(a.id);
    expect(closed?.status).toBe("closed");
  });

  it("closes expired assignments", async () => {
    await store.create({ title: "F", description: "", deadline: Date.now() - 1000, format: "individual", attachments: [], status: "open", createdBy: "t" });
    await store.create({ title: "G", description: "", deadline: Date.now() + 999999, format: "individual", attachments: [], status: "open", createdBy: "t" });
    const count = await store.closeExpired();
    expect(count).toBe(1);
    const all = await store.list({ status: "open" });
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("G");
  });

  it("counts by status", async () => {
    await store.create({ title: "H", description: "", deadline: 0, format: "individual", attachments: [], status: "open", createdBy: "t" });
    await store.create({ title: "I", description: "", deadline: 0, format: "individual", attachments: [], status: "closed", createdBy: "t" });
    const counts = await store.countByStatus();
    expect(counts).toEqual({ open: 1, closed: 1, total: 2 });
  });
});
