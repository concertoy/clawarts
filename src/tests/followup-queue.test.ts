import { describe, it, expect } from "vitest";
import { enqueueFollowup, hasFollowups, clearFollowups, type FollowupItem } from "../queue/followup-queue.js";

function makeItem(text: string, ts?: string): FollowupItem {
  return { text, userId: "U123", ts: ts ?? `ts-${Date.now()}-${Math.random()}`, enqueuedAt: Date.now() };
}

describe("followup-queue", () => {
  // Use unique session keys per test to avoid interference
  let key: string;
  let counter = 0;
  const nextKey = () => `fq-test-${++counter}-${Date.now()}`;

  it("enqueues a followup item", () => {
    key = nextKey();
    const ok = enqueueFollowup(key, makeItem("hello"));
    expect(ok).toBe(true);
    expect(hasFollowups(key)).toBe(true);
  });

  it("deduplicates by timestamp", () => {
    key = nextKey();
    const item = makeItem("hello", "fixed-ts");
    expect(enqueueFollowup(key, item)).toBe(true);
    expect(enqueueFollowup(key, { ...item })).toBe(false); // same ts
  });

  it("clears followups and returns count", () => {
    key = nextKey();
    enqueueFollowup(key, makeItem("a"));
    enqueueFollowup(key, makeItem("b"));
    const cleared = clearFollowups(key);
    expect(cleared).toBe(2);
    expect(hasFollowups(key)).toBe(false);
  });

  it("hasFollowups returns false for empty queue", () => {
    expect(hasFollowups(nextKey())).toBe(false);
  });

  it("clearFollowups returns 0 for unknown session", () => {
    expect(clearFollowups(nextKey())).toBe(0);
  });

  it("registers drain callback without immediate execution", () => {
    key = nextKey();
    let called = false;
    enqueueFollowup(key, makeItem("msg"), async () => { called = true; });
    // Drain is async/debounced — should not fire synchronously
    expect(called).toBe(false);
    // Clean up to prevent timer leak
    clearFollowups(key);
  });
});
