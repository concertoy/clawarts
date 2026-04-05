import { describe, it, expect } from "vitest";
import { errMsg, isFileNotFound, isAbortError } from "../utils/errors.js";

describe("errMsg", () => {
  it("extracts Error.message", () => {
    expect(errMsg(new Error("test"))).toBe("test");
  });
  it("stringifies non-Error", () => {
    expect(errMsg("raw string")).toBe("raw string");
    expect(errMsg(42)).toBe("42");
    expect(errMsg(null)).toBe("null");
  });
});

describe("isFileNotFound", () => {
  it("returns true for ENOENT", () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    expect(isFileNotFound(err)).toBe(true);
  });
  it("returns false for other errors", () => {
    expect(isFileNotFound(new Error("something"))).toBe(false);
    expect(isFileNotFound("string")).toBe(false);
  });
  it("returns false for EACCES", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(isFileNotFound(err)).toBe(false);
  });
});

describe("isAbortError", () => {
  it("detects AbortError by name", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });
  it("detects abort by message", () => {
    expect(isAbortError(new Error("signal was abort"))).toBe(true);
  });
  it("returns false for normal errors", () => {
    expect(isAbortError(new Error("timeout"))).toBe(false);
  });
});
