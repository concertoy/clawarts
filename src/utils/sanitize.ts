/**
 * Strip potentially sensitive information from error messages before
 * displaying them to end users (e.g., in Slack).
 *
 * Removes: absolute file paths, API keys/tokens, stack traces.
 */

const PATTERNS: [RegExp, string][] = [
  // Slack tokens (xoxb-, xapp-, xoxp-), API keys (sk-ant-, sk-proj-, sk-)
  [/\b(xoxb|xapp|xoxp|sk-ant|sk-proj|sk-)[a-zA-Z0-9\-_]{10,}/g, "[REDACTED]"],
  // Absolute file paths (/Users/..., /home/..., C:\...)
  [/(?:\/(?:Users|home|tmp|var|etc)\/[^\s"']+|[A-Z]:\\[^\s"']+)/g, "[PATH]"],
  // Bearer tokens
  [/Bearer\s+[a-zA-Z0-9\-_.]+/gi, "Bearer [REDACTED]"],
  // Generic long hex/base64 tokens (40+ chars)
  [/\b[a-f0-9]{40,}\b/gi, "[TOKEN]"],
];

export function sanitizeForUser(message: string): string {
  let result = message;
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
