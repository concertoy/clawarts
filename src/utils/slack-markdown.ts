/**
 * Convert GitHub-flavored Markdown to Slack's mrkdwn format.
 * Claude outputs standard Markdown but Slack uses its own formatting syntax.
 *
 * Key differences:
 *   Markdown **bold** → Slack *bold*
 *   Markdown *italic* → Slack _italic_
 *   Markdown [text](url) → Slack <url|text>
 *   Markdown # Header → Slack *Header*
 *   Markdown > blockquote → Slack > blockquote (same)
 *   Markdown ```code``` → Slack ```code``` (same)
 *   Markdown `inline` → Slack `inline` (same)
 */

export function markdownToSlack(md: string): string {
  let result = md;

  // Protect code blocks from transformation — extract, transform around them, then restore.
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCodes.push(match);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });

  // Images: ![alt](url) → <url|alt> (must run before link conversion)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Headers: # Header → *Header* (bold in Slack, with newline for spacing)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold → placeholder first to prevent italic regex from clobbering it.
  // **text** or __text__ → \x01text\x02
  result = result.replace(/\*\*(.+?)\*\*/g, "\x01$1\x02");
  result = result.replace(/__(.+?)__/g, "\x01$1\x02");

  // Italic: *text* → _text_ (safe now — bold is placeholdered)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // Restore bold: placeholder → *text*
  result = result.replace(/\x01(.+?)\x02/g, "*$1*");

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Horizontal rules: --- or *** → ───
  result = result.replace(/^[-*_]{3,}$/gm, "───────────────────────");

  // Markdown tables → plaintext (Slack can't render tables)
  // Convert | col1 | col2 | rows into indented text, drop separator rows
  result = result.replace(/^\|[-:| ]+\|$/gm, ""); // drop separator rows like |---|---|
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) => {
    return inner
      .split("|")
      .map((cell: string) => cell.trim())
      .filter(Boolean)
      .join("  ·  ");
  });

  // Restore inline codes
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)]);

  // Restore code blocks
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

  // Clean up excess blank lines left by transformations
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
