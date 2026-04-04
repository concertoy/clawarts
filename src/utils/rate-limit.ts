/**
 * Fixed-window rate limiter. Ported from openclaw's implementation.
 * Counts requests within a rolling time window; rejects when the limit is hit.
 */

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

export interface RateLimiter {
  consume: () => RateLimitResult;
  reset: () => void;
}

export function createRateLimiter(params: {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const maxRequests = Math.max(1, Math.floor(params.maxRequests));
  const windowMs = Math.max(1, Math.floor(params.windowMs));
  const now = params.now ?? Date.now;

  let count = 0;
  let windowStartMs = 0;

  return {
    consume() {
      const nowMs = now();
      if (nowMs - windowStartMs >= windowMs) {
        windowStartMs = nowMs;
        count = 0;
      }
      if (count >= maxRequests) {
        return {
          allowed: false,
          retryAfterMs: Math.max(0, windowStartMs + windowMs - nowMs),
          remaining: 0,
        };
      }
      count += 1;
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: Math.max(0, maxRequests - count),
      };
    },
    reset() {
      count = 0;
      windowStartMs = 0;
    },
  };
}
