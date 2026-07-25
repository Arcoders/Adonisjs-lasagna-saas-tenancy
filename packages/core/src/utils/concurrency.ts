/**
 * Run `fn` over `items` with at most `limit` in flight, preserving RESULT ORDER
 * (result[i] is fn(items[i])). A fixed pool of `min(limit, items.length)` workers
 * pulls from a shared cursor, so the slowest item never blocks a free worker from
 * starting the next one. `limit` is floored at 1.
 *
 * Failure isolation is the CALLER's contract: this never rejects on a per-item
 * error, so a caller that wants one item's failure not to abort the batch catches
 * inside `fn` and returns an outcome. An `fn` that throws rejects the whole batch
 * (the worker's promise rejects and `Promise.all` surfaces it), which is the right
 * default for a caller that has NOT opted into isolation.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const poolSize = Math.max(1, Math.min(Math.floor(limit), items.length))
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  }

  await Promise.all(Array.from({ length: poolSize }, () => worker()))
  return results
}
