import { describe, it, expect } from "vitest";
import { execAsync } from "../utils/exec-async.js";

describe("execAsync", () => {
  it("captures stdout", async () => {
    const result = await execAsync("echo hello");
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr", async () => {
    const result = await execAsync("echo oops >&2");
    expect(result.stderr).toBe("oops");
    expect(result.exitCode).toBe(0);
  });

  it("returns non-zero exit code", async () => {
    const result = await execAsync("exit 42");
    expect(result.exitCode).toBe(42);
  });

  it("respects cwd option", async () => {
    const result = await execAsync("pwd", { cwd: "/tmp" });
    expect(result.stdout).toMatch(/\/tmp/);
  });

  it("times out long-running commands", async () => {
    const result = await execAsync("sleep 10", { timeout: 100 });
    expect(result.stderr).toContain("TIMEOUT");
    expect(result.exitCode).toBeNull();
  });

  it("aborts via signal", async () => {
    const ac = new AbortController();
    const p = execAsync("sleep 10", { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const result = await p;
    expect(result.exitCode).toBeNull();
  });
});
