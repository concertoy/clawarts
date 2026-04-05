import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadWorkspaceFiles } from "../workspace.js";

describe("loadWorkspaceFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawarts-ws-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for empty workspace", () => {
    const files = loadWorkspaceFiles(tmpDir);
    expect(files).toEqual([]);
  });

  it("loads SOUL.md", () => {
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "You are a helpful tutor.");
    const files = loadWorkspaceFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("SOUL.md");
    expect(files[0].content).toBe("You are a helpful tutor.");
  });

  it("strips YAML frontmatter", () => {
    fs.writeFileSync(
      path.join(tmpDir, "SOUL.md"),
      "---\ntitle: Test\n---\nHello world",
    );
    const files = loadWorkspaceFiles(tmpDir);
    expect(files[0].content).toBe("Hello world");
  });

  it("loads multiple bootstrap files", () => {
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "persona");
    fs.writeFileSync(path.join(tmpDir, "TOOLS.md"), "tools info");
    fs.writeFileSync(path.join(tmpDir, "COURSE.md"), "course info");
    const files = loadWorkspaceFiles(tmpDir);
    expect(files).toHaveLength(3);
    expect(files.map((f) => f.name)).toEqual(["SOUL.md", "TOOLS.md", "COURSE.md"]);
  });

  it("ignores non-bootstrap files", () => {
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "persona");
    fs.writeFileSync(path.join(tmpDir, "random.md"), "should be ignored");
    const files = loadWorkspaceFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("SOUL.md");
  });

  it("skips empty files", () => {
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "");
    const files = loadWorkspaceFiles(tmpDir);
    expect(files).toEqual([]);
  });

  it("truncates very long files", () => {
    const longContent = "x".repeat(25_000);
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), longContent);
    const files = loadWorkspaceFiles(tmpDir);
    expect(files[0].content.length).toBeLessThan(longContent.length);
    expect(files[0].content).toContain("truncated");
  });
});
