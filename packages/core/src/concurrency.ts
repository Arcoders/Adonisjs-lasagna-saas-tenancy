/**
 * Pure, dependency-free bounded-concurrency batching. The branchy core behind
 * {@link mapTenants}: slice work into width-sized batches, run each batch
 * concurrently, and partition outcomes into results vs errors. Knows nothing about
 * tenancy or I/O, so every branch is unit-testable without a booted app.
 */

export interface BoundedBatchOptions<I> {
  /** Peak in-flight workers. Clamped to >= 1. `Infinity` runs everything at once. */
  concurrency: number
  /**
   * `true` (default at the caller): an item that throws is collected into `errors`
   * and the batch continues. `false`: the first error rejects the whole call —
   * but only after the in-flight slice has fully settled (no dangling rejections).
   */
  continueOnError: boolean
  /** Stable key for an item, carried on both results and errors for correlation. */
  keyOf: (item: I) => string
}

export interface BoundedBatchResult<O> {
  results: Array<{ key: string; value: O }>
  errors: Array<{ key: string; error: Error }>
}

export async function boundedBatch<I, O>(
  items: I[],
  worker: (item: I) => Promise<O>,
  opts: BoundedBatchOptions<I>
): Promise<BoundedBatchResult<O>> {
  const width = Math.max(1, Math.floor(opts.concurrency) || 1)
  const results: Array<{ key: string; value: O }> = []
  const errors: Array<{ key: string; error: Error }> = []

  for (let i = 0; i < items.length; i += width) {
    const slice = items.slice(i, i + width)
    // allSettled so the whole slice resolves before we inspect — guarantees no
    // unhandled rejection escapes even when we're about to throw.
    const settled = await Promise.allSettled(
      slice.map(async (item) => {
        const key = opts.keyOf(item)
        try {
          // `await` normalizes a synchronous throw in `worker` into a rejection too.
          const value = await worker(item)
          return { key, value, ok: true as const }
        } catch (error) {
          return { key, error: error as Error, ok: false as const }
        }
      })
    )

    for (const outcome of settled) {
      // The mapper always resolves (it catches), so this is always 'fulfilled';
      // the defensive `rejected` branch keeps us safe if that ever changes.
      const r = outcome.status === 'fulfilled' ? outcome.value : null
      if (!r) {
        const error = (outcome as PromiseRejectedResult).reason as Error
        if (!opts.continueOnError) throw error
        errors.push({ key: 'unknown', error })
        continue
      }
      if (r.ok) {
        results.push({ key: r.key, value: r.value })
      } else {
        if (!opts.continueOnError) throw r.error
        errors.push({ key: r.key, error: r.error })
      }
    }
  }

  return { results, errors }
}
