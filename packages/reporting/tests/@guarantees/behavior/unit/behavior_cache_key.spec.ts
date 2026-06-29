import { test } from '@japa/runner'
import { reportingCacheKey } from '../../../../src/cache_key.js'

test.group('reportingCacheKey', () => {
  test('same logical query → same key', ({ assert }) => {
    const a = reportingCacheKey({
      period: 'week',
      since: '2026-01-01',
      until: '2026-02-01',
      limit: 20,
    })
    const b = reportingCacheKey({
      period: 'week',
      since: '2026-01-01',
      until: '2026-02-01',
      limit: 20,
    })
    assert.equal(a, b)
  })

  test('any differing parameter → different key', ({ assert }) => {
    const base = reportingCacheKey({
      period: 'day',
      since: '2026-01-01',
      until: '2026-02-01',
      limit: 10,
    })
    assert.notEqual(
      base,
      reportingCacheKey({ period: 'week', since: '2026-01-01', until: '2026-02-01', limit: 10 })
    )
    assert.notEqual(
      base,
      reportingCacheKey({ period: 'day', since: '2026-01-02', until: '2026-02-01', limit: 10 })
    )
    assert.notEqual(
      base,
      reportingCacheKey({ period: 'day', since: '2026-01-01', until: '2026-02-02', limit: 10 })
    )
    assert.notEqual(
      base,
      reportingCacheKey({ period: 'day', since: '2026-01-01', until: '2026-02-01', limit: 11 })
    )
  })

  test('defaults: empty options is stable and uses day', ({ assert }) => {
    assert.equal(reportingCacheKey(), reportingCacheKey({}))
    assert.match(reportingCacheKey(), /period=day/)
  })

  test('undefined and invalid limit normalize equal (no cache fragmentation)', ({ assert }) => {
    const a = reportingCacheKey({ period: 'day' })
    const b = reportingCacheKey({ period: 'day', limit: Number.NaN })
    assert.equal(a, b)
  })

  // CHAOS: the cache is GLOBAL (cross-tenant) — the key must never be tenant-scoped.
  test('the key never contains a tenant: prefix', ({ assert }) => {
    const k = reportingCacheKey({
      period: 'day',
      since: '2026-01-01',
      until: '2026-02-01',
      limit: 5,
    })
    assert.notInclude(k, 'tenant:')
  })
})
