import { test } from '@japa/runner'
import {
  CUSTOM_AGGREGATIONS,
  isCustomAggregation,
  resolveCustomAggregation,
  aggregationSql,
  isSafeMetricName,
  assertSafeMetricName,
  mapCustomBreakdownRow,
} from '../../../../src/custom_aggregate.js'

test.group('custom_aggregate — aggregation whitelist', () => {
  test('every whitelisted aggregation maps to its SQL function', ({ assert }) => {
    const expected: Record<string, string> = {
      sum: 'SUM',
      avg: 'AVG',
      count: 'COUNT',
      max: 'MAX',
      min: 'MIN',
    }
    for (const agg of CUSTOM_AGGREGATIONS) {
      assert.equal(aggregationSql(agg), expected[agg])
    }
  })

  test('isCustomAggregation guards the whitelist', ({ assert }) => {
    assert.isTrue(isCustomAggregation('sum'))
    assert.isFalse(isCustomAggregation('median'))
    assert.isFalse(isCustomAggregation(undefined))
  })

  // CHAOS: an unknown/malicious aggregation can never inject SQL — it collapses to SUM.
  test('resolveCustomAggregation defaults unknown values to sum', ({ assert }) => {
    assert.equal(resolveCustomAggregation('median'), 'sum')
    assert.equal(resolveCustomAggregation('SUM(x);DROP TABLE t;--'), 'sum')
    assert.equal(resolveCustomAggregation(undefined), 'sum')
    assert.equal(aggregationSql('SUM(x);DROP TABLE t;--'), 'SUM')
  })
})

test.group('custom_aggregate — metric name safety', () => {
  test('accepts safe identifiers up to 63 chars', ({ assert }) => {
    for (const n of ['bookings', 'revenue_cents', 'a-b', 'a'.repeat(63)]) {
      assert.isTrue(isSafeMetricName(n))
      assert.doesNotThrow(() => assertSafeMetricName(n))
    }
  })

  test('rejects unsafe / over-long names', ({ assert }) => {
    for (const n of ["x'; DROP", 'a:b', 'a b', 'a.b', '', 'a'.repeat(64), 7 as any, null as any]) {
      assert.isFalse(isSafeMetricName(n))
      assert.throws(() => assertSafeMetricName(n), /unsafe metric name/)
    }
  })
})

test.group('custom_aggregate — mapCustomBreakdownRow', () => {
  test('coerces bigint-as-string / null totals to a finite number', ({ assert }) => {
    assert.deepEqual(mapCustomBreakdownRow({ name: 'bookings', total: '42' }), {
      name: 'bookings',
      total: 42,
    })
    assert.deepEqual(mapCustomBreakdownRow({ name: 'x', total: null }), { name: 'x', total: 0 })
    assert.deepEqual(mapCustomBreakdownRow({ name: 'x' }), { name: 'x', total: 0 })
  })
})
