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
