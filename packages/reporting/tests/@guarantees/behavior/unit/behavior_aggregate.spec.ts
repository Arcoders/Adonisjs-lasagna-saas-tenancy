import { test } from '@japa/runner'
import {
  errorRate,
  toNumber,
  mapAggregateRow,
  mapTopTenantRow,
  clampLimit,
} from '../../../../src/aggregate.js'

test.group('errorRate', () => {
  test('is errors / requests', ({ assert }) => {
    assert.equal(errorRate(5, 100), 0.05)
  })

  test('is 0 when there are no requests (no divide-by-zero)', ({ assert }) => {
    assert.equal(errorRate(0, 0), 0)
    assert.equal(errorRate(3, 0), 0)
  })

  test('clamps to 1 when errors exceed requests', ({ assert }) => {
    assert.equal(errorRate(150, 100), 1)
  })
})

test.group('toNumber', () => {
  test('coerces bigint-as-string SQL aggregates', ({ assert }) => {
    assert.equal(toNumber('4200'), 4200)
  })

  test('maps null/undefined/non-finite to 0', ({ assert }) => {
    assert.equal(toNumber(null), 0)
    assert.equal(toNumber(undefined), 0)
    assert.equal(toNumber('not-a-number'), 0)
  })
})

test.group('mapAggregateRow', () => {
  test('maps snake_case aggregates and computes the error rate', ({ assert }) => {
    const out = mapAggregateRow({
      bucket: '2026-06-01',
      total_requests: '1000',
      total_errors: '50',
      total_bandwidth: '999999',
      active_tenants: '7',
    })
    assert.deepEqual(out, {
      period: '2026-06-01',
      totalRequests: 1000,
      totalErrors: 50,
      totalBandwidthBytes: 999999,
      activeTenants: 7,
      errorRate: 0.05,
    })
  })

  test('renders a Date bucket as a YYYY-MM-DD string', ({ assert }) => {
    const out = mapAggregateRow({ bucket: new Date('2026-06-15T00:00:00Z') })
    assert.equal(out.period, '2026-06-15')
    assert.equal(out.totalRequests, 0)
    assert.equal(out.errorRate, 0)
  })
})

test.group('mapTopTenantRow', () => {
  test('maps a tenant row and computes the error rate', ({ assert }) => {
    const out = mapTopTenantRow({
      tenant_id: 't-1',
      requests: '200',
      errors: '20',
      bandwidth_bytes: '500',
    })
    assert.deepEqual(out, {
      tenantId: 't-1',
      requests: 200,
      errors: 20,
      bandwidthBytes: 500,
      errorRate: 0.1,
    })
  })
})

test.group('clampLimit', () => {
  test('defaults to 50 when undefined or non-finite', ({ assert }) => {
    assert.equal(clampLimit(undefined), 50)
    assert.equal(clampLimit(Number.NaN), 50)
  })

  test('clamps to [1, 1000] and floors', ({ assert }) => {
    assert.equal(clampLimit(0), 1)
    assert.equal(clampLimit(-5), 1)
    assert.equal(clampLimit(5000), 1000)
    assert.equal(clampLimit(12.9), 12)
  })
})
