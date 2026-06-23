import { test } from '@japa/runner'
import { assertNotInTenantScope } from '../../src/guard.js'

/**
 * The data-leak guard is a security control: cross-tenant aggregation must never
 * run inside a `tenancy.run()` scope (where it could surface another tenant's
 * data in a tenant context). The current-tenant getter is passed in, so this is
 * a pure unit test — production callers pass the real `tenancy.currentId`.
 */
test.group('assertNotInTenantScope', () => {
  test('throws when a tenant scope is active', ({ assert }) => {
    assert.throws(
      () => assertNotInTenantScope('getAggregate', () => 'tenant-abc'),
      /data-leak guard/
    )
  })

  test('names the operation in the error', ({ assert }) => {
    assert.throws(
      () => assertNotInTenantScope('getTopTenants', () => 'tenant-abc'),
      /ReportingService\.getTopTenants\(\)/
    )
  })

  test('is a no-op outside any tenant scope', ({ assert }) => {
    assert.doesNotThrow(() => assertNotInTenantScope('getAggregate', () => undefined))
  })
})
