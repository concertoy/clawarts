import { describe, it, expect } from "vitest";
import { getVersion } from "../utils/version.js";

describe("getVersion", () => {
  it("returns a semver-like version string", () => {
    const version = getVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns the same value on repeated calls (cached)", () => {
    expect(getVersion()).toBe(getVersion());
  });
});
