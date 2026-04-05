import { describe, it, expect } from "vitest";
import { BoundedMap } from "../utils/bounded-map.js";

describe("BoundedMap", () => {
  it("evicts oldest entry when at capacity", () => {
    const map = new BoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("d", 4); // evicts "a"
    expect(map.has("a")).toBe(false);
    expect(map.get("d")).toBe(4);
    expect(map.size).toBe(3);
  });

  it("re-inserting a key moves it to end (most recent)", () => {
    const map = new BoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("a", 10); // refresh "a"
    map.set("d", 4); // should evict "b" (oldest), not "a"
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
    expect(map.get("a")).toBe(10);
  });

  it("throws on maxSize < 1", () => {
    expect(() => new BoundedMap<string, number>(0)).toThrow("maxSize must be >= 1");
    expect(() => new BoundedMap<string, number>(-5)).toThrow("maxSize must be >= 1");
  });
});
