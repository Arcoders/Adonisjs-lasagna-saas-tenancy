import { test } from '@japa/runner'
import replicaLagCheck from '../../../../src/services/doctor/checks/replica_lag_check.js'
import { mockTenantRepository } from '../../../../src/testing/mock_repository.js'
import { setupTestConfig } from '../../../helpers/config.js'

test.group('replicaLagCheck', (group) => {
  group.each.setup(() => setupTestConfig())

  test('returns no issues when read replicas are not configured', async ({ assert }) => {
    setupTestConfig() // no tenantReadReplicas
    const issues = await replicaLagCheck.run({
      tenants: [],
      repo: mockTenantRepository(),
      attemptFix: false,
    })
    assert.deepEqual(issues, [])
  })

  test('returns no issues when replicas array is empty', async ({ assert }) => {
    setupTestConfig({
      tenantReadReplicas: { hosts: [] },
    })
    const issues = await replicaLagCheck.run({
      tenants: [],
      repo: mockTenantRepository(),
      attemptFix: false,
    })
    assert.deepEqual(issues, [])
  })

  test('declares the required shape', ({ assert }) => {
    assert.equal(replicaLagCheck.name, 'replica_lag')
    assert.match(replicaLagCheck.description, /replica/i)
    assert.isFunction(replicaLagCheck.run)
  })
})
