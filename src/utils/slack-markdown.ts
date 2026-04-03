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

  // Headers: # Header → *Header* (bold in Slack)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");

  // Italic: *text* or _text_ → _text_ (but be careful not to double-transform bold)
  // Only convert standalone *single* asterisks (not ** which we already handled)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)]\(([^)]+)\)/g, "<$2|$1>");

  // Images: ![alt](url) → <url|alt> (Slack doesn't render images inline, just link)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

  // Horizontal rules: --- or *** → ───
  result = result.replace(/^[-*_]{3,}$/gm, "───────────────────────");

  // Restore inline codes
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)]);

  // Restore code blocks
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

  return result;
}
