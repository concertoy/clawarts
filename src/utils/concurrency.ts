/**
 * Run async tasks with bounded concurrency.
 * Ported from openclaw's runTasksWithConcurrency (simplified).
 *
 * All tasks run regardless of individual failures (continue mode).
 * Returns PromiseSettledResult[] for the caller to inspect.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];

  const cap = Math.max(1, Math.min(limit, items.length));
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  // Workers share a `next` counter. This is safe because JavaScript is
  // single-threaded: the read-increment `const i = next++` completes
  // atomically before any other worker can execute.
  const workers = Array.from({ length: cap }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  });

  await Promise.allSettled(workers);
  return results;
}
