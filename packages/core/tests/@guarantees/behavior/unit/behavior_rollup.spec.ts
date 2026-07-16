import { test } from '@japa/runner'
import {
  buildMonthlyRollupSql,
  firstOfMonth,
  endOfMonth,
  endOfLastCompletedMonth,
  resolveRollupWindow,
  monthBuckets,
  monthChunkBounds,
} from '../../../../src/rollup.js'

test.group('rollup — buildMonthlyRollupSql (overwrite-not-accumulate, parameterized)', () => {
  const sql = buildMonthlyRollupSql()

  test('uses ??.?? identifier placeholders for target + source and ? for the dates', ({
    assert,
  }) => {
    // two `??.??` pairs give four `??`; exactly two `?` date params.
    assert.equal((sql.match(/\?\?/g) ?? []).length, 4)
    const singleQ = sql.replace(/\?\?/g, '').match(/\?/g) ?? []
    assert.equal(singleQ.length, 2)
    assert.match(sql, /WHERE period >= \? AND period <= \?/)
  })

  test('conflict clause OVERWRITES with EXCLUDED, never accumulates', ({ assert }) => {
    assert.match(sql, /ON CONFLICT \(tenant_id, month\) DO UPDATE/)
    assert.include(sql, 'EXCLUDED.request_count')
    // the trap: `col = col + EXCLUDED.col` would double-count on re-run.
    assert.notMatch(sql, /request_count\s*\+/)
  })

  test('buckets by the whitelisted DATE_TRUNC month, never user input', ({ assert }) => {
    assert.include(sql, "DATE_TRUNC('month', period)::date")
  })
})

test.group('rollup — month math (UTC)', () => {
  test('firstOfMonth', ({ assert }) => {
    assert.equal(firstOfMonth('2026-06-24'), '2026-06-01')
    assert.equal(firstOfMonth('2026-06-01'), '2026-06-01')
  })

  test('endOfMonth handles 30/31 and leap February', ({ assert }) => {
    assert.equal(endOfMonth('2026-06-15'), '2026-06-30')
    assert.equal(endOfMonth('2026-01-01'), '2026-01-31')
    assert.equal(endOfMonth('2024-02-10'), '2024-02-29') // leap
    assert.equal(endOfMonth('2026-02-10'), '2026-02-28') // non-leap
  })

  test('endOfLastCompletedMonth excludes the open month, crosses years', ({ assert }) => {
    assert.equal(endOfLastCompletedMonth('2026-06-24'), '2026-05-31')
    assert.equal(endOfLastCompletedMonth('2026-03-01'), '2026-02-28') // first day maps to prev month end
    assert.equal(endOfLastCompletedMonth('2026-01-15'), '2025-12-31') // year boundary
  })
})

test.group('rollup — resolveRollupWindow', () => {
  test('defaults: first-of-month(min) → end of last completed month', ({ assert }) => {
    assert.deepEqual(resolveRollupWindow({ minPeriod: '2025-03-15', asOf: '2026-06-24' }), {
      since: '2025-03-01',
      until: '2026-05-31',
    })
  })

  test('explicit since/until honored verbatim (host may backfill the open month)', ({ assert }) => {
    assert.deepEqual(
      resolveRollupWindow({
        minPeriod: '2025-03-15',
        since: '2026-01-01',
        until: '2026-06-24',
        asOf: '2026-06-24',
      }),
      { since: '2026-01-01', until: '2026-06-24' }
    )
  })

  test('explicit since only → until defaults to last completed month', ({ assert }) => {
    assert.deepEqual(
      resolveRollupWindow({ minPeriod: null, since: '2026-01-01', asOf: '2026-06-24' }),
      { since: '2026-01-01', until: '2026-05-31' }
    )
  })

  test('empty base table and no explicit since → null (command no-ops)', ({ assert }) => {
    assert.isNull(resolveRollupWindow({ minPeriod: null, asOf: '2026-06-24' }))
  })
})

test.group('rollup — monthBuckets & monthChunkBounds', () => {
  test('monthBuckets walks every month inclusive, ascending', ({ assert }) => {
    assert.deepEqual(monthBuckets('2026-01-15', '2026-03-10'), [
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ])
    assert.deepEqual(monthBuckets('2026-01-05', '2026-01-31'), ['2026-01-01'])
    assert.deepEqual(monthBuckets('2025-11-05', '2026-02-20'), [
      '2025-11-01',
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ])
  })

  test('monthBuckets returns [] for an inverted window', ({ assert }) => {
    assert.deepEqual(monthBuckets('2026-03-01', '2026-01-01'), [])
  })

  test('monthChunkBounds clamps the first/last month to the window edges', ({ assert }) => {
    const window = { since: '2026-01-15', until: '2026-03-10' }
    assert.deepEqual(monthChunkBounds('2026-01-01', window), { lo: '2026-01-15', hi: '2026-01-31' })
    assert.deepEqual(monthChunkBounds('2026-02-01', window), { lo: '2026-02-01', hi: '2026-02-28' })
    assert.deepEqual(monthChunkBounds('2026-03-01', window), { lo: '2026-03-01', hi: '2026-03-10' })
  })
})
