import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import provisioningStalledCheck from '../../../../src/services/doctor/checks/provisioning_stalled_check.js'
import { mockTenantRepository } from '../../../../src/testing/mock_repository.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import { setupTestConfig } from '../../../helpers/config.js'

test.group('provisioningStalledCheck', (group) => {
  group.each.setup(() => setupTestConfig())

  test('does not flag a recently-created provisioning tenant', async ({ assert }) => {
    const tenant = buildTestTenant({
      status: 'provisioning',
      createdAt: DateTime.utc().minus({ minutes: 5 }),
    })
    const issues = (await provisioningStalledCheck.run({
      tenants: [tenant],
      repo: mockTenantRepository(),
      attemptFix: false,
    })) as any[]
    assert.lengthOf(issues, 0)
  })

  test('flags a tenant stuck for more than 30 minutes', async ({ assert }) => {
    const tenant = buildTestTenant({
      status: 'provisioning',
      createdAt: DateTime.utc().minus({ hours: 2 }),
    })
    const issues = (await provisioningStalledCheck.run({
      tenants: [tenant],
      repo: mockTenantRepository(),
      attemptFix: false,
    })) as any[]
    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'provisioning_stalled')
    assert.equal(issues[0].severity, 'error')
    assert.isTrue(issues[0].fixable)
    assert.isAtLeast(issues[0].meta.stalledMinutes, 30)
  })

  test('with --fix, marks the tenant as failed', async ({ assert }) => {
    const tenant = buildTestTenant({
      status: 'provisioning',
      createdAt: DateTime.utc().minus({ hours: 2 }),
    })
    const issues = (await provisioningStalledCheck.run({
      tenants: [tenant],
      repo: mockTenantRepository(),
      attemptFix: true,
    })) as any[]

    assert.equal(tenant.status, 'failed')
    assert.equal(issues[0].meta.fixed, true)
  })

  test('ignores non-provisioning tenants regardless of age', async ({ assert }) => {
    const tenant = buildTestTenant({
      status: 'active',
      createdAt: DateTime.utc().minus({ years: 1 }),
    })
    const issues = (await provisioningStalledCheck.run({
      tenants: [tenant],
      repo: mockTenantRepository(),
      attemptFix: false,
    })) as any[]
    assert.lengthOf(issues, 0)
  })
})
