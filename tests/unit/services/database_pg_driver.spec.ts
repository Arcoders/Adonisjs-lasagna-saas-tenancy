import { test } from '@japa/runner'
import DatabasePgDriver from '../../../src/services/isolation/database_pg_driver.js'
import { setupTestConfig } from '../../helpers/config.js'
import type { TenantModelContract } from '../../../src/types/contracts.js'

const fakeTenant = (id: string) =>
  ({ id, name: `tenant-${id}` }) as unknown as TenantModelContract

test.group('DatabasePgDriver — naming', (group) => {
  group.each.setup(() => setupTestConfig())

  test('reports its driver name', ({ assert }) => {
    const driver = new DatabasePgDriver()
    assert.equal(driver.name, 'database-pg')
  })

  test('connectionName uses the shared tenantConnectionNamePrefix', ({ assert }) => {
    const driver = new DatabasePgDriver()
    assert.equal(driver.connectionName('abc'), 'tenant_abc')
  })

  test('databaseName accepts a tenant id string and a TenantModelContract', ({
    assert,
  }) => {
    const driver = new DatabasePgDriver()
    assert.equal(driver.databaseName('xyz'), 'tenant_xyz')
    assert.equal(driver.databaseName(fakeTenant('xyz')), 'tenant_xyz')
  })

  test('databaseName honors a constructor-level prefix override', ({ assert }) => {
    const driver = new DatabasePgDriver({ databasePrefix: 'app_db_' })
    assert.equal(driver.databaseName('1'), 'app_db_1')
  })

  test('databaseName picks up runtime config changes when no override given', ({
    assert,
  }) => {
    setupTestConfig({ tenantSchemaPrefix: 'live_' })
    const driver = new DatabasePgDriver()
    assert.equal(driver.databaseName('q'), 'live_q')
  })
})
