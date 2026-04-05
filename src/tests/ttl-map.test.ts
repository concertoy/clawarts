import { describe, it, expect } from "vitest";
import { TTLMap } from "../utils/ttl-map.js";

describe("TTLMap", () => {
  it("stores and retrieves values", () => {
    const map = new TTLMap<string, number>({ maxSize: 10, ttlMs: 1000, sweepIntervalMs: 0 });
    map.set("a", 1);
    expect(map.get("a")).toBe(1);
  });

  it("returns undefined for missing keys", () => {
    const map = new TTLMap<string, number>({ maxSize: 10, ttlMs: 1000, sweepIntervalMs: 0 });
    expect(map.get("missing")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    let now = 1000;
    const map = new TTLMap<string, number>({
      maxSize: 10,
      ttlMs: 100,
      sweepIntervalMs: 0,
      now: () => now,
    });
    map.set("a", 1);
    expect(map.get("a")).toBe(1);
    now = 1101; // past TTL
    expect(map.get("a")).toBeUndefined();
  });

  it("has() returns false for expired keys", () => {
    let now = 1000;
    const map = new TTLMap<string, string>({
      maxSize: 10,
      ttlMs: 50,
      sweepIntervalMs: 0,
      now: () => now,
    });
    map.set("x", "val");
    expect(map.has("x")).toBe(true);
    now = 1051;
    expect(map.has("x")).toBe(false);
  });

  it("evicts oldest when full", () => {
    const map = new TTLMap<string, number>({ maxSize: 2, ttlMs: 10_000, sweepIntervalMs: 0 });
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
  });

  it("sweep removes expired entries", () => {
    let now = 1000;
    const map = new TTLMap<string, number>({
      maxSize: 10,
      ttlMs: 100,
      sweepIntervalMs: 0,
      now: () => now,
    });
    map.set("a", 1);
    map.set("b", 2);
    expect(map.size).toBe(2);
    now = 1200;
    map.sweep();
    expect(map.size).toBe(0);
  });

  it("delete removes entry", () => {
    const map = new TTLMap<string, number>({ maxSize: 10, ttlMs: 1000, sweepIntervalMs: 0 });
    map.set("a", 1);
    expect(map.delete("a")).toBe(true);
    expect(map.get("a")).toBeUndefined();
  });

  it("clear empties the map", () => {
    const map = new TTLMap<string, number>({ maxSize: 10, ttlMs: 1000, sweepIntervalMs: 0 });
    map.set("a", 1);
    map.set("b", 2);
    map.clear();
    expect(map.size).toBe(0);
  });
});
