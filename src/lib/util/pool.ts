/**
 * Run `fn` over `items` with at most `concurrency` calls in flight.
 *
 * Work is taken in order; no new item starts once `shouldStop()` returns true
 * or once any call has thrown. Rejects with the first error a call throws
 * (after the calls already in flight have settled).
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed && !shouldStop()) {
      const index = next++;
      try {
        await fn(items[index]!, index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker);
  const results = await Promise.allSettled(workers);
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (rejected) throw rejected.reason;
}
