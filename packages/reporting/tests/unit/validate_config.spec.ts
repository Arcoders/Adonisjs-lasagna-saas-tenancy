import { test } from '@japa/runner'
import {
  assertReportingConfig,
  defineReportingConfig,
  type ReportingConfig,
} from '../../src/validate_config.js'

test.group('assertReportingConfig', () => {
  test('undefined / empty block passes (optional)', ({ assert }) => {
    assert.doesNotThrow(() => assertReportingConfig(undefined))
    assert.doesNotThrow(() => assertReportingConfig({}))
    assert.doesNotThrow(() => assertReportingConfig({ metrics: [] }))
  })

  test('valid metric definitions pass', ({ assert }) => {
    const cfg: ReportingConfig = {
      metrics: [
        { name: 'bookings', aggregation: 'count', description: 'Confirmed bookings' },
        { name: 'revenue_cents', aggregation: 'sum' },
        { name: 'a'.repeat(63) },
      ],
    }
    assert.doesNotThrow(() => assertReportingConfig(cfg))
  })

  test('rejects a non-array metrics', ({ assert }) => {
    assert.throws(() => assertReportingConfig({ metrics: {} as any }), /must be an array/)
  })

  test('rejects an unsafe metric name', ({ assert }) => {
    assert.throws(
      () => assertReportingConfig({ metrics: [{ name: "x'; DROP" }] }),
      /metric name .* is invalid/
    )
    assert.throws(() => assertReportingConfig({ metrics: [{ name: 'a'.repeat(64) }] }), /invalid/)
  })

  test('rejects a duplicate metric name', ({ assert }) => {
    assert.throws(
      () => assertReportingConfig({ metrics: [{ name: 'bookings' }, { name: 'bookings' }] }),
      /duplicate metric name/
    )
  })

  test('rejects an invalid aggregation', ({ assert }) => {
    assert.throws(
      () => assertReportingConfig({ metrics: [{ name: 'x', aggregation: 'median' as any }] }),
      /invalid aggregation/
    )
  })

  test('rejects a non-string description', ({ assert }) => {
    assert.throws(
      () => assertReportingConfig({ metrics: [{ name: 'x', description: 7 as any }] }),
      /description must be a string/
    )
  })
})

test.group('defineReportingConfig', () => {
  test('is an identity passthrough', ({ assert }) => {
    const cfg: ReportingConfig = { metrics: [{ name: 'bookings' }] }
    assert.strictEqual(defineReportingConfig(cfg), cfg)
  })
})
