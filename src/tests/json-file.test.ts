import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { atomicWriteJson, readJsonFile } from "../utils/json-file.js";

describe("json-file", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawarts-jsonfile-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("atomicWriteJson", () => {
    it("writes JSON file", async () => {
      const filePath = path.join(tmpDir, "test.json");
      await atomicWriteJson(filePath, { hello: "world" });
      const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(content).toEqual({ hello: "world" });
    });

    it("creates parent directories", async () => {
      const filePath = path.join(tmpDir, "deep", "nested", "file.json");
      await atomicWriteJson(filePath, { nested: true });
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("overwrites existing file", async () => {
      const filePath = path.join(tmpDir, "overwrite.json");
      await atomicWriteJson(filePath, { version: 1 });
      await atomicWriteJson(filePath, { version: 2 });
      const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(content.version).toBe(2);
    });

    it("does not leave temp files on success", async () => {
      const filePath = path.join(tmpDir, "clean.json");
      await atomicWriteJson(filePath, {});
      const files = fs.readdirSync(tmpDir);
      expect(files).toEqual(["clean.json"]);
    });
  });

  describe("readJsonFile", () => {
    it("reads existing JSON file", async () => {
      const filePath = path.join(tmpDir, "read.json");
      fs.writeFileSync(filePath, '{"key":"value"}');
      const result = await readJsonFile<{ key: string }>(filePath);
      expect(result).toEqual({ key: "value" });
    });

    it("returns null for missing file", async () => {
      const result = await readJsonFile(path.join(tmpDir, "missing.json"));
      expect(result).toBeNull();
    });

    it("throws on invalid JSON", async () => {
      const filePath = path.join(tmpDir, "bad.json");
      fs.writeFileSync(filePath, "not json");
      await expect(readJsonFile(filePath)).rejects.toThrow();
    });
  });
});
