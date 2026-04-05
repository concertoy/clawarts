import { describe, it, expect } from "vitest";
import { chunkText, sanitizeInput, stripMention } from "../utils/slack-text.js";

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });

  it("breaks at newline within limit", () => {
    const chunks = chunkText("line one\nline two\nline three", 15);
    expect(chunks[0]).toBe("line one");
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("breaks at space when no newline", () => {
    const chunks = chunkText("hello world foo", 11);
    expect(chunks[0]).toBe("hello world");
  });

  it("hard-cuts when no break point", () => {
    const chunks = chunkText("abcdefghij", 5);
    expect(chunks[0]).toBe("abcde");
    expect(chunks[1]).toBe("fghij");
  });

  it("returns empty string in single chunk", () => {
    expect(chunkText("", 100)).toEqual([""]);
  });

  it("handles text exactly at limit", () => {
    expect(chunkText("12345", 5)).toEqual(["12345"]);
  });
});

describe("sanitizeInput", () => {
  it("removes zero-width spaces", () => {
    expect(sanitizeInput("hello\u200Bworld")).toBe("helloworld");
  });
  it("removes BOM", () => {
    expect(sanitizeInput("\uFEFFtext")).toBe("text");
  });
  it("preserves normal whitespace", () => {
    expect(sanitizeInput("hello world\n")).toBe("hello world\n");
  });
  it("strips bidi directional isolates (Trojan Source)", () => {
    expect(sanitizeInput("hello\u2066\u2069world")).toBe("helloworld");
  });
  it("strips RTLO override character", () => {
    expect(sanitizeInput("file\u202Efdp.exe")).toBe("filefdp.exe");
  });
  it("strips null bytes", () => {
    expect(sanitizeInput("hello\x00world")).toBe("helloworld");
  });
});

describe("stripMention", () => {
  it("strips bot mention", () => {
    expect(stripMention("<@U12345> hello", "U12345")).toBe("hello");
  });
  it("strips multiple mentions", () => {
    expect(stripMention("<@U12345> hi <@U12345>", "U12345")).toBe("hi");
  });
  it("returns trimmed text when no mention", () => {
    expect(stripMention("hello", "U12345")).toBe("hello");
  });
});
