import { test } from '@japa/runner'
import SchemaPgDriver from '../../../src/services/isolation/schema_pg_driver.js'
import { setupTestConfig } from '../../helpers/config.js'
import type { TenantModelContract } from '../../../src/types/contracts.js'

const fakeTenant = (id: string) =>
  ({ id, name: `tenant-${id}` }) as unknown as TenantModelContract

test.group('SchemaPgDriver — naming', (group) => {
  group.each.setup(() => setupTestConfig())

  test('connectionName combines prefix from config with tenant id', ({ assert }) => {
    const driver = new SchemaPgDriver()
    assert.equal(driver.connectionName('abc'), 'tenant_abc')
  })

  test('schemaName accepts a tenant id string', ({ assert }) => {
    const driver = new SchemaPgDriver()
    assert.equal(driver.schemaName('xyz'), 'tenant_xyz')
  })

  test('schemaName accepts a TenantModelContract', ({ assert }) => {
    const driver = new SchemaPgDriver()
    assert.equal(driver.schemaName(fakeTenant('xyz')), 'tenant_xyz')
  })

  test('reports its driver name', ({ assert }) => {
    const driver = new SchemaPgDriver()
    assert.equal(driver.name, 'schema-pg')
  })

  test('honors a custom prefix coming from config overrides', ({ assert }) => {
    setupTestConfig({ tenantConnectionNamePrefix: 'pool_', tenantSchemaPrefix: 'sch_' })
    const driver = new SchemaPgDriver()
    assert.equal(driver.connectionName('1'), 'pool_1')
    assert.equal(driver.schemaName('1'), 'sch_1')
  })
})
