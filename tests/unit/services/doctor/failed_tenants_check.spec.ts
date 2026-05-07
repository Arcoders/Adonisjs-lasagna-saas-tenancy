import { test } from '@japa/runner'
import failedTenantsCheck from '../../../../src/services/doctor/checks/failed_tenants_check.js'
import { mockTenantRepository } from '../../../../src/testing/mock_repository.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import { setupTestConfig } from '../../../helpers/config.js'

test.group('failedTenantsCheck', (group) => {
  group.each.setup(() => setupTestConfig())

  test('returns no issues when no tenant is in failed state', ({ assert }) => {
    const repo = mockTenantRepository()
    const tenants = [
      buildTestTenant({ status: 'active' }),
      buildTestTenant({ status: 'suspended' }),
    ]

    const issues = failedTenantsCheck.run({
      tenants,
      repo,
      attemptFix: false,
    }) as any[]

    assert.lengthOf(issues, 0)
  })

  test('flags tenants whose status is failed', ({ assert }) => {
    const repo = mockTenantRepository()
    const a = buildTestTenant({ status: 'failed' })
    const b = buildTestTenant({ status: 'active' })
    const c = buildTestTenant({ status: 'failed' })

    const issues = failedTenantsCheck.run({
      tenants: [a, b, c],
      repo,
      attemptFix: false,
    }) as any[]

    assert.lengthOf(issues, 2)
    const ids = issues.map((i) => i.tenantId).sort()
    assert.deepEqual(ids, [a.id, c.id].sort())
    for (const i of issues) {
      assert.equal(i.code, 'tenant_failed')
      assert.equal(i.severity, 'error')
    }
  })
})
