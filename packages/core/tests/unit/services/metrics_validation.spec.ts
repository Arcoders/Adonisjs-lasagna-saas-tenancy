import { test } from '@japa/runner'
import {
  assertMetricName,
  assertMetricValue,
  assertEmitMetricArgs,
} from '../../../src/services/metrics_validation.js'

test.group('metrics validation — assertMetricName', () => {
  test('accepts snake_case and uuid-ish names', ({ assert }) => {
    for (const name of ['rental_bookings', 'revenue_cents', 'a', 'metric-1', 'a'.repeat(63)]) {
      assert.doesNotThrow(() => assertMetricName(name))
    }
  })

  test('rejects a 64-char name (over the 63 identifier limit)', ({ assert }) => {
    assert.doesNotThrow(() => assertMetricName('a'.repeat(63)))
    assert.throws(() => assertMetricName('a'.repeat(64)))
  })

  test('rejects names with SQL/Redis metacharacters', ({ assert }) => {
    for (const name of [
      "x'; DROP TABLE tenant_custom_metrics; --",
      'a:b',
      'a b',
      'a.b',
      '',
      '"x"',
    ]) {
      assert.throws(() => assertMetricName(name), /unsafe/i)
    }
  })
})

test.group('metrics validation — assertMetricValue', () => {
  test('accepts finite integers including zero and negatives', ({ assert }) => {
    for (const v of [0, 1, 500, -3, 2_000_000_000]) {
      assert.doesNotThrow(() => assertMetricValue(v))
    }
  })

  test('rejects floats, NaN, Infinity, and non-numbers', ({ assert }) => {
    for (const v of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '5' as any, null as any]) {
      assert.throws(() => assertMetricValue(v), /finite integer/)
    }
  })
})

test.group('metrics validation — assertEmitMetricArgs', () => {
  test('passes when both name and value are valid', ({ assert }) => {
    assert.doesNotThrow(() => assertEmitMetricArgs('bookings', 1))
  })

  test('validates the name before the value (name error wins)', ({ assert }) => {
    // A bad name AND a bad value: the name check must fire first, proving args
    // are validated before any Redis call could run.
    assert.throws(() => assertEmitMetricArgs('bad name', 1.5), /unsafe/i)
  })

  test('rejects a bad value when the name is fine', ({ assert }) => {
    assert.throws(() => assertEmitMetricArgs('bookings', 1.5), /finite integer/)
  })
})
