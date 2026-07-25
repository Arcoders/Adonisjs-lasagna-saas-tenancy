import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import tenantLifecycleCheck from '../../../../src/services/doctor/checks/tenant_lifecycle_check.js'
import { mockTenantRepository } from '../../../../src/testing/mock_repository.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import { setupTestConfig } from '../../../helpers/config.js'

/**
 * Matrix rows 6 + 14: the status/deletedAt lifecycle reconciliation. A recent
 * deletedAt keeps the retention-expired branch (which needs a DB) untouched, so
 * these stay pure unit tests.
 */
test.group('tenantLifecycleCheck', (group) => {
  group.each.setup(() => setupTestConfig())

  test('flags a soft-deleted tenant whose status is not "deleted" (divergence)', async ({
    assert,
  }) => {
    const tenant = buildTestTenant({ status: 'active', deletedAt: DateTime.now() })
    const issues = await tenantLifecycleCheck.run({
      tenants: [tenant],
      repo: mockTenantRepository([tenant]),
      attemptFix: false,
    })
    assert.lengthOf(issues, 1)
    assert.equal(issues[0]!.code, 'lifecycle_status_divergence')
    assert.equal(issues[0]!.severity, 'warn')
    assert.equal(issues[0]!.scope, 'tenant')
    assert.isTrue(issues[0]!.fixable)
  })

  test('--fix reconciles the divergent status to "deleted" (status write only)', async ({
    assert,
  }) => {
    const tenant = buildTestTenant({ status: 'active', deletedAt: DateTime.now() })
    const issues = await tenantLifecycleCheck.run({
      tenants: [tenant],
      repo: mockTenantRepository([tenant]),
      attemptFix: true,
    })
    assert.equal(tenant.status, 'deleted')
    assert.equal((issues[0]!.meta as any).fixed, true)
  })

  test('flags status "deleted" without a timestamp (inverse) as info, no fix', async ({
    assert,
  }) => {
    const tenant = buildTestTenant({ status: 'deleted', deletedAt: null })
    const issues = await tenantLifecycleCheck.run({
      tenants: [tenant],
      repo: mockTenantRepository([tenant]),
      attemptFix: false,
    })
    assert.lengthOf(issues, 1)
    assert.equal(issues[0]!.code, 'lifecycle_deleted_without_timestamp')
    assert.equal(issues[0]!.severity, 'info')
    assert.notProperty(issues[0]!, 'fixable')
  })

  test('no issue for a healthy active tenant or a consistent recent soft-delete', async ({
    assert,
  }) => {
    const active = buildTestTenant({ status: 'active', deletedAt: null })
    const deletedConsistent = buildTestTenant({ status: 'deleted', deletedAt: DateTime.now() })
    const issues = await tenantLifecycleCheck.run({
      tenants: [active, deletedConsistent],
      repo: mockTenantRepository(),
      attemptFix: false,
    })
    assert.lengthOf(issues, 0)
  })
})
