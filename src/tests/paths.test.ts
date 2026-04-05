import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { expandTilde, clawHome } from "../utils/paths.js";
import { createPathResolver } from "../tools/paths.js";

describe("expandTilde", () => {
  it("expands ~/path to home directory", () => {
    expect(expandTilde("~/docs")).toBe(path.join(os.homedir(), "docs"));
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandTilde("/usr/local")).toBe("/usr/local");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandTilde("foo/bar")).toBe("foo/bar");
  });

  it("handles just ~/ (empty suffix)", () => {
    expect(expandTilde("~/")).toBe(path.join(os.homedir(), ""));
  });
});

describe("clawHome", () => {
  it("resolves to ~/.clawarts/", () => {
    expect(clawHome()).toBe(path.join(os.homedir(), ".clawarts"));
  });

  it("appends segments", () => {
    expect(clawHome("agents", "tutor")).toBe(
      path.join(os.homedir(), ".clawarts", "agents", "tutor"),
    );
  });

  it("handles single segment", () => {
    expect(clawHome("config.json")).toBe(
      path.join(os.homedir(), ".clawarts", "config.json"),
    );
  });
});

describe("createPathResolver", () => {
  const workspace = "/tmp/test-workspace";
  const { resolveFilePath, validateWritePath } = createPathResolver(workspace);

  it("resolves relative paths to workspace", () => {
    expect(resolveFilePath("foo.txt")).toBe(path.resolve(workspace, "foo.txt"));
  });

  it("resolves absolute paths as-is", () => {
    expect(resolveFilePath("/etc/passwd")).toBe("/etc/passwd");
  });

  it("resolves tilde paths to home directory", () => {
    expect(resolveFilePath("~/docs")).toBe(path.resolve(path.join(os.homedir(), "docs")));
  });

  it("rejects write paths outside workspace", () => {
    const err = validateWritePath("/etc/passwd");
    expect(err).not.toBeNull();
    expect(err).toContain("outside the workspace");
  });

  it("rejects write paths with .. traversal", () => {
    const traversal = path.resolve(workspace, "..", "escape.txt");
    const err = validateWritePath(traversal);
    expect(err).not.toBeNull();
  });

  it("accepts write paths inside workspace", () => {
    const inside = path.resolve(workspace, "subdir", "file.txt");
    const err = validateWritePath(inside);
    expect(err).toBeNull();
  });
});
