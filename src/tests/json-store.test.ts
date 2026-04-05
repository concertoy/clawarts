import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadStore, saveStore, withStoreLock } from "../store/json-store.js";

describe("json-store", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawarts-test-"));
    storePath = path.join(tmpDir, "test-store.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadStore", () => {
    it("returns empty store when file does not exist", async () => {
      const store = await loadStore(storePath);
      expect(store.version).toBe(1);
      expect(store.items).toEqual([]);
    });

    it("loads valid store file", async () => {
      const data = { version: 1, items: [{ id: "1", name: "test" }] };
      fs.writeFileSync(storePath, JSON.stringify(data), "utf-8");

      const store = await loadStore(storePath);
      expect(store.items).toHaveLength(1);
      expect(store.items[0]).toEqual({ id: "1", name: "test" });
    });

    it("returns empty store for corrupted JSON", async () => {
      fs.writeFileSync(storePath, "not json", "utf-8");

      const store = await loadStore(storePath);
      expect(store.items).toEqual([]);
    });

    it("returns empty store for wrong version", async () => {
      fs.writeFileSync(storePath, JSON.stringify({ version: 99, items: [] }), "utf-8");

      const store = await loadStore(storePath);
      expect(store.items).toEqual([]);
    });
  });

  describe("saveStore + loadStore round-trip", () => {
    it("persists and loads data correctly", async () => {
      const items = [{ id: "a" }, { id: "b" }];
      await saveStore(storePath, { version: 1, items });

      const loaded = await loadStore(storePath);
      expect(loaded.items).toEqual(items);
    });
  });

  describe("withStoreLock", () => {
    it("serializes concurrent operations", async () => {
      const order: number[] = [];

      const op1 = withStoreLock(storePath, async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 20));
        order.push(2);
      });

      const op2 = withStoreLock(storePath, async () => {
        order.push(3);
        order.push(4);
      });

      await Promise.all([op1, op2]);
      // op2 should not start until op1 finishes
      expect(order).toEqual([1, 2, 3, 4]);
    });

    it("releases lock on error", async () => {
      await expect(
        withStoreLock(storePath, async () => { throw new Error("boom"); }),
      ).rejects.toThrow("boom");

      // Should still be able to acquire lock
      const result = await withStoreLock(storePath, async () => "ok");
      expect(result).toBe("ok");
    });
  });
});
