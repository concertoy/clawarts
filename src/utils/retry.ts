/**
 * Retry wrapper with exponential backoff and jitter.
 * Ported from claude-code's withRetry.ts — simplified for Slack bot workload.
 */

const DEFAULT_MAX_RETRIES = 5;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;

export interface RetryOptions {
  maxRetries?: number;
  /** Called before each retry with attempt number and delay. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Returns true if the error is retriable (429, 529, connection errors).
 * Ported from claude-code's error classification in withRetry.ts.
 */
function isRetriable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Never retry aborted requests — ported from claude-code's abort detection in retry
  if (err.name === "AbortError" || err.message.includes("abort")) return false;

  const msg = err.message.toLowerCase();

  // HTTP status-based errors (from fetch wrapper or API error messages)
  if (/\b429\b/.test(msg)) return true; // rate limit
  if (/\b529\b/.test(msg)) return true; // overloaded
  if (/\b502\b|\b503\b|\b504\b/.test(msg)) return true; // gateway/service errors
  if (/overloaded/.test(msg)) return true; // Anthropic overloaded_error in body

  // Connection errors
  if (/econnreset|epipe|econnrefused|etimedout|socket hang up|fetch failed/i.test(msg)) return true;

  return false;
}

/**
 * Extract retry-after delay from error message (if the error includes it).
 * Some APIs embed "retry-after: N" in error responses.
 */
function extractRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/retry[- ]?after[:\s]+(\d+)/i);
  if (!match) return null;
  const seconds = parseInt(match[1], 10);
  // If < 1000, assume seconds; otherwise assume already ms
  return seconds < 1000 ? seconds * 1000 : seconds;
}

/**
 * Compute backoff delay with jitter.
 * Ported from claude-code: BASE_DELAY_MS * 2^(attempt-1) + 25% random jitter.
 */
function getDelay(attempt: number, retryAfterMs?: number | null): number {
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.min(retryAfterMs, MAX_DELAY_MS);
  }
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt - 1);
  const jitter = exponential * 0.25 * Math.random();
  return Math.min(exponential + jitter, MAX_DELAY_MS);
}

/**
 * Execute fn with automatic retry on retriable errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries || !isRetriable(err)) {
        throw err;
      }

      const retryAfter = extractRetryAfterMs(err);
      const delay = getDelay(attempt + 1, retryAfter);

      opts?.onRetry?.(attempt + 1, delay, err);
      console.log(`[retry] Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${Math.round(delay)}ms`);

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
