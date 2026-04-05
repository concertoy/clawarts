import { describe, it, expect } from "vitest";
import { markdownToSlack } from "../utils/slack-markdown.js";

describe("markdownToSlack", () => {
  it("converts bold", () => {
    expect(markdownToSlack("**hello**")).toBe("*hello*");
  });

  it("converts italic", () => {
    expect(markdownToSlack("*hello*")).toBe("_hello_");
  });

  it("converts bold+italic", () => {
    expect(markdownToSlack("***hello***")).toBe("*_hello_*");
  });

  it("converts links", () => {
    expect(markdownToSlack("[click](https://example.com)")).toBe("<https://example.com|click>");
  });

  it("converts images", () => {
    expect(markdownToSlack("![alt](https://img.png)")).toBe("<https://img.png|alt>");
  });

  it("converts headers to bold", () => {
    expect(markdownToSlack("# Title")).toBe("*Title*");
    expect(markdownToSlack("### Subtitle")).toBe("*Subtitle*");
  });

  it("converts strikethrough", () => {
    expect(markdownToSlack("~~deleted~~")).toBe("~deleted~");
  });

  it("converts bullets", () => {
    expect(markdownToSlack("- item 1\n- item 2")).toBe("• item 1\n• item 2");
  });

  it("preserves code blocks", () => {
    const input = "```js\nconst x = **bold**;\n```";
    expect(markdownToSlack(input)).toBe(input);
  });

  it("preserves inline code", () => {
    expect(markdownToSlack("`**not bold**`")).toBe("`**not bold**`");
  });

  it("converts horizontal rules", () => {
    expect(markdownToSlack("---")).toBe("───────────────────────");
  });

  it("converts table rows to plaintext", () => {
    const input = "| Name | Score |\n|------|-------|\n| Alice | 95 |";
    const result = markdownToSlack(input);
    expect(result).toContain("Name  ·  Score");
    expect(result).not.toContain("|---|");
  });

  it("collapses excess blank lines", () => {
    expect(markdownToSlack("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("converts __underscore bold__ to Slack bold", () => {
    expect(markdownToSlack("__hello__")).toBe("*hello*");
  });

  it("handles underscore bold with inner underscores", () => {
    expect(markdownToSlack("__my_var__")).toBe("*my_var*");
  });

  it("preserves blockquotes", () => {
    expect(markdownToSlack("> quoted text")).toBe("> quoted text");
  });

  it("handles mixed bold and italic in same line", () => {
    expect(markdownToSlack("**bold** and *italic*")).toBe("*bold* and _italic_");
  });

  it("handles nested emphasis edge case", () => {
    // Bold wrapping italic: **_word_** → *_word_*
    expect(markdownToSlack("**_word_**")).toBe("*_word_*");
  });
});
