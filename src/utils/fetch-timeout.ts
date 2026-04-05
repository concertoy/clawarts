/**
 * Fetch wrapper with built-in AbortController timeout.
 * Replaces the repeated pattern of:
 *   const controller = new AbortController();
 *   const timer = setTimeout(() => controller.abort(), timeout);
 *   if (timer.unref) timer.unref();
 *   try { ... } finally { clearTimeout(timer); }
 */

export interface FetchTimeoutOptions extends Omit<RequestInit, "signal"> {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  url: string,
  options: FetchTimeoutOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchInit } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    return await fetch(url, { ...fetchInit, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
