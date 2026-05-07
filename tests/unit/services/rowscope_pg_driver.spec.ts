import { test } from '@japa/runner'
import RowScopePgDriver from '../../../src/services/isolation/rowscope_pg_driver.js'
import { setupTestConfig } from '../../helpers/config.js'
import type { TenantModelContract } from '../../../src/types/contracts.js'

const fakeTenant = (id: string) =>
  ({ id, name: `tenant-${id}` }) as unknown as TenantModelContract

test.group('RowScopePgDriver — naming and configuration', (group) => {
  group.each.setup(() => setupTestConfig())

  test('reports its driver name', ({ assert }) => {
    const driver = new RowScopePgDriver()
    assert.equal(driver.name, 'rowscope-pg')
  })

  test('connectionName returns the central/template connection name', ({ assert }) => {
    const driver = new RowScopePgDriver({ centralConnectionName: 'central' })
    assert.equal(driver.connectionName('any'), 'central')
  })

  test('default scope column is tenant_id', ({ assert }) => {
    const driver = new RowScopePgDriver()
    assert.equal(driver.scopeColumn, 'tenant_id')
  })

  test('honors a custom scope column', ({ assert }) => {
    const driver = new RowScopePgDriver({ scopeColumn: 'org_id' })
    assert.equal(driver.scopeColumn, 'org_id')
  })
})

test.group('RowScopePgDriver — provision/migrate semantics', (group) => {
  group.each.setup(() => setupTestConfig())

  test('provision is a no-op (storage is shared)', async ({ assert }) => {
    const driver = new RowScopePgDriver()
    await assert.doesNotReject(() => driver.provision(fakeTenant('a')))
  })

  test('migrate reports noop because central migrations own the schema', async ({
    assert,
  }) => {
    const driver = new RowScopePgDriver()
    const result = await driver.migrate(fakeTenant('a'), {} as any)
    assert.deepEqual(result, { executed: 0, noop: true })
  })

  test('disconnect is a no-op (the connection is shared)', async ({ assert }) => {
    const driver = new RowScopePgDriver()
    await assert.doesNotReject(() => driver.disconnect(fakeTenant('a')))
  })

  test('destroy with no scoped tables configured is a no-op', async ({ assert }) => {
    const driver = new RowScopePgDriver({ scopedTables: [] })
    await assert.doesNotReject(() => driver.destroy(fakeTenant('a')))
  })

  test('destroy with keepData: true short-circuits even if tables configured', async ({
    assert,
  }) => {
    const driver = new RowScopePgDriver({ scopedTables: ['posts', 'comments'] })
    // No DB hit because keepData skips the loop before any lucid() call.
    await assert.doesNotReject(() => driver.destroy(fakeTenant('a'), { keepData: true }))
  })
})
