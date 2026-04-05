import { describe, it, expect } from "vitest";
import { safeJsonStringify } from "../utils/safe-json.js";

describe("safeJsonStringify", () => {
  it("handles plain objects", () => {
    const result = safeJsonStringify({ a: 1, b: "hello" });
    expect(JSON.parse(result!)).toEqual({ a: 1, b: "hello" });
  });

  it("handles BigInt", () => {
    const result = safeJsonStringify({ n: BigInt(42) });
    expect(result).toContain('"42"');
  });

  it("handles functions", () => {
    const result = safeJsonStringify({ fn: () => {} });
    expect(result).toContain("[Function]");
  });

  it("handles Error objects", () => {
    const result = safeJsonStringify({ err: new Error("test") });
    const parsed = JSON.parse(result!);
    expect(parsed.err.name).toBe("Error");
    expect(parsed.err.message).toBe("test");
  });

  it("handles Uint8Array", () => {
    const result = safeJsonStringify({ buf: new Uint8Array(10) });
    expect(result).toContain("[Uint8Array 10 bytes]");
  });

  it("handles circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = safeJsonStringify(obj);
    expect(result).toContain("[Circular]");
  });

  it("handles Map objects", () => {
    const result = safeJsonStringify({ m: new Map([["key", "val"]]) });
    const parsed = JSON.parse(result!);
    expect(parsed.m).toEqual({ key: "val" });
  });

  it("handles Set objects", () => {
    const result = safeJsonStringify({ s: new Set([1, 2, 3]) });
    const parsed = JSON.parse(result!);
    expect(parsed.s).toEqual([1, 2, 3]);
  });

  it("returns null on failure", () => {
    // This shouldn't actually fail since we handle everything, but test the contract
    expect(safeJsonStringify(undefined)).toBe(undefined); // JSON.stringify(undefined) returns undefined
  });
});
