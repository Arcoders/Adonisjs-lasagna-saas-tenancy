import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { buildTestTenant } from '../../../src/testing/builders.js'
import { setupTestConfig } from '../../helpers/config.js'

test.group('buildTestTenant', (group) => {
  group.each.setup(() => setupTestConfig())

  test('produces a tenant satisfying TenantModelContract with sensible defaults', ({ assert }) => {
    const tenant = buildTestTenant()
    assert.isString(tenant.id)
    assert.match(
      tenant.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    assert.isString(tenant.name)
    assert.match(tenant.email, /@fixture\.test$/)
    assert.equal(tenant.status, 'active')
    assert.isNull(tenant.customDomain)
    assert.isNull(tenant.deletedAt)
    assert.isTrue(tenant.isActive)
    assert.isFalse(tenant.isDeleted)
  })

  test('overrides take precedence over defaults', ({ assert }) => {
    const tenant = buildTestTenant({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Acme',
      email: 'a@b.c',
      status: 'suspended',
      customDomain: 'acme.test',
    })
    assert.equal(tenant.id, '11111111-1111-4111-8111-111111111111')
    assert.equal(tenant.name, 'Acme')
    assert.equal(tenant.email, 'a@b.c')
    assert.equal(tenant.status, 'suspended')
    assert.equal(tenant.customDomain, 'acme.test')
    assert.isTrue(tenant.isSuspended)
    assert.isFalse(tenant.isActive)
  })

  test('schemaName follows config prefix and replaces hyphens with underscores', ({ assert }) => {
    setupTestConfig({ tenantSchemaPrefix: 'tnt_' })
    const tenant = buildTestTenant({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
    assert.equal(tenant.schemaName, 'tnt_aaaaaaaa_bbbb_4ccc_8ddd_eeeeeeeeeeee')
  })

  test('suspend() and activate() mutate status in-memory', async ({ assert }) => {
    const tenant = buildTestTenant({ status: 'active' })
    await tenant.suspend()
    assert.equal(tenant.status, 'suspended')
    await tenant.activate()
    assert.equal(tenant.status, 'active')
  })

  test('isDeleted reflects deletedAt', ({ assert }) => {
    const tenant = buildTestTenant()
    assert.isFalse(tenant.isDeleted)

    const tenantDeleted = buildTestTenant({ deletedAt: DateTime.now() })
    assert.isTrue(tenantDeleted.isDeleted)
  })
})
