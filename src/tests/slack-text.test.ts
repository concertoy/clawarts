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
