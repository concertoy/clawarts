/**
 * Slack text utilities — chunking and mention stripping.
 * Extracted from slack.ts for reusability.
 */

/**
 * Split text into chunks that fit within Slack's message limit.
 * Prefers breaking at newlines, then spaces, then hard-cuts.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = remaining.lastIndexOf("\n", limit);
    if (breakPoint <= 0) {
      breakPoint = remaining.lastIndexOf(" ", limit);
    }
    if (breakPoint <= 0) {
      breakPoint = limit;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

/**
 * Strip invisible Unicode characters that can confuse parsing.
 * Preserves normal whitespace (space, tab, newline) but removes:
 * - Zero-width spaces (U+200B), joiners (U+200C/D), no-break hints
 * - Byte-order marks (U+FEFF)
 * - Various Unicode format/control characters
 * - Bidi directional isolates (U+2066-U+2069) — prevent RTLO/Trojan Source attacks
 */
export function sanitizeInput(text: string): string {
  return text.replace(/[\u200B-\u200F\u2028-\u202F\u2066-\u2069\uFEFF\u00AD]/g, "");
}

const mentionRegexCache = new Map<string, RegExp>();

/** Strip @bot mentions from message text. */
export function stripMention(text: string, botUserId: string): string {
  let re = mentionRegexCache.get(botUserId);
  if (!re) {
    re = new RegExp(`<@${botUserId}>`, "g");
    mentionRegexCache.set(botUserId, re);
  }
  re.lastIndex = 0;
  return text.replace(re, "").trim();
}
