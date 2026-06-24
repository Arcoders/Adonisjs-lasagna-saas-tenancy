import { test } from '@japa/runner'
import { boundedBatch } from '../../src/concurrency.js'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const keyOf = (n: number) => String(n)
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

/** Wraps a worker to record the peak number of concurrently in-flight calls. */
function peakTracker() {
  let active = 0
  let peak = 0
  return {
    peak: () => peak,
    wrap:
      <T>(fn: (n: number) => Promise<T>) =>
      async (n: number) => {
        active += 1
        peak = Math.max(peak, active)
        try {
          await delay(5)
          return await fn(n)
        } finally {
          active -= 1
        }
      },
  }
}

test.group('boundedBatch — concurrency bound', () => {
  for (const width of [1, 3, 10]) {
    test(`peak in-flight never exceeds width=${width}`, async ({ assert }) => {
      const t = peakTracker()
      const { results } = await boundedBatch(
        range(25),
        t.wrap(async (n) => n * 2),
        {
          concurrency: width,
          continueOnError: true,
          keyOf,
        }
      )
      assert.lengthOf(results, 25)
      assert.isAtMost(t.peak(), width)
    })
  }

  test('large N is fully processed with a small width', async ({ assert }) => {
    const t = peakTracker()
    const { results, errors } = await boundedBatch(
      range(1000),
      t.wrap(async (n) => n),
      {
        concurrency: 10,
        continueOnError: true,
        keyOf,
      }
    )
    assert.lengthOf(results, 1000)
    assert.lengthOf(errors, 0)
    assert.isAtMost(t.peak(), 10)
  }).timeout(30_000)

  // META: prove the batching barrier is load-bearing — an unbounded Promise.all
  // over the same tracked worker reaches peak = N, while boundedBatch stays <= width.
  test('META: an unbounded baseline reaches full concurrency, boundedBatch does not', async ({
    assert,
  }) => {
    const unbounded = peakTracker()
    await Promise.all(range(20).map(unbounded.wrap(async (n) => n)))
    assert.equal(unbounded.peak(), 20)

    const bounded = peakTracker()
    await boundedBatch(
      range(20),
      bounded.wrap(async (n) => n),
      {
        concurrency: 4,
        continueOnError: true,
        keyOf,
      }
    )
    assert.isAtMost(bounded.peak(), 4)
  })
})

test.group('boundedBatch — results & ordering', () => {
  test('all-success preserves item order in results', async ({ assert }) => {
    const { results, errors } = await boundedBatch(range(10), async (n) => n * 10, {
      concurrency: 3,
      continueOnError: true,
      keyOf,
    })
    assert.lengthOf(errors, 0)
    assert.deepEqual(
      results.map((r) => r.value),
      range(10).map((n) => n * 10)
    )
    assert.deepEqual(
      results.map((r) => r.key),
      range(10).map(String)
    )
  })

  test('falsy return values are captured, not dropped', async ({ assert }) => {
    const inputs = [0, 1, 2, 3]
    const vals: any[] = [undefined, null, 0, '']
    const { results } = await boundedBatch(inputs, async (n) => vals[n], {
      concurrency: 2,
      continueOnError: true,
      keyOf,
    })
    assert.lengthOf(results, 4)
    assert.deepEqual(
      results.map((r) => r.value),
      vals
    )
  })

  test('empty input → empty result, no throw', async ({ assert }) => {
    const out = await boundedBatch([], async (n) => n, {
      concurrency: 5,
      continueOnError: true,
      keyOf,
    })
    assert.deepEqual(out, { results: [], errors: [] })
  })
})

test.group('boundedBatch — error handling', () => {
  test('continueOnError:true isolates a single failure', async ({ assert }) => {
    const { results, errors } = await boundedBatch(
      range(5),
      async (n) => {
        if (n === 2) throw new Error('boom-2')
        return n
      },
      { concurrency: 2, continueOnError: true, keyOf }
    )
    assert.lengthOf(results, 4)
    assert.lengthOf(errors, 1)
    assert.equal(errors[0].key, '2')
    assert.match(errors[0].error.message, /boom-2/)
  })

  test('continueOnError:true collects multiple failures', async ({ assert }) => {
    const { results, errors } = await boundedBatch(
      range(6),
      async (n) => {
        if (n % 2 === 0) throw new Error(`even-${n}`)
        return n
      },
      { concurrency: 3, continueOnError: true, keyOf }
    )
    assert.lengthOf(results, 3)
    assert.lengthOf(errors, 3)
    assert.deepEqual(errors.map((e) => e.key).sort(), ['0', '2', '4'])
  })

  test('a synchronously-throwing worker is partitioned, not uncaught', async ({ assert }) => {
    const { results, errors } = await boundedBatch(
      range(3),
      // sync throw (not an async rejection)
      ((n: number) => {
        if (n === 1) throw new Error('sync-boom')
        return Promise.resolve(n)
      }) as (n: number) => Promise<number>,
      { concurrency: 3, continueOnError: true, keyOf }
    )
    assert.lengthOf(results, 2)
    assert.lengthOf(errors, 1)
    assert.equal(errors[0].key, '1')
  })

  test('continueOnError:false rejects with the first error and leaks no unhandled rejection', async ({
    assert,
  }) => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      await assert.rejects(
        () =>
          boundedBatch(
            range(6),
            async (n) => {
              await delay(2)
              if (n >= 2) throw new Error(`fail-${n}`)
              return n
            },
            { concurrency: 4, continueOnError: false, keyOf }
          ),
        /fail-/
      )
      // let any stray rejection surface on the next ticks
      await delay(20)
      assert.lengthOf(unhandled, 0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

test.group('boundedBatch — concurrency clamping', () => {
  test('concurrency 0 / negative clamps to 1 (still completes)', async ({ assert }) => {
    for (const c of [0, -5]) {
      const { results } = await boundedBatch(range(4), async (n) => n, {
        concurrency: c,
        continueOnError: true,
        keyOf,
      })
      assert.lengthOf(results, 4)
    }
  })

  test('concurrency Infinity runs everything at once without crashing', async ({ assert }) => {
    const t = peakTracker()
    const { results } = await boundedBatch(
      range(12),
      t.wrap(async (n) => n),
      {
        concurrency: Infinity,
        continueOnError: true,
        keyOf,
      }
    )
    assert.lengthOf(results, 12)
    assert.equal(t.peak(), 12)
  })
})
