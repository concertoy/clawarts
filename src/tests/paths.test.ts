import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { expandTilde, clawHome } from "../utils/paths.js";

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
