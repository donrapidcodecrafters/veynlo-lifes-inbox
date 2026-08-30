/**
 * Runs `fn` over every item in `items` with at most `limit` in flight at once. Unlike a bare
 * `Promise.all(items.map(fn))`, this bounds concurrency — needed for any per-user/per-connection fan-out
 * that would otherwise open as many DB/queue round trips as there are rows (thousands+ at real scale).
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await fn(item);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
