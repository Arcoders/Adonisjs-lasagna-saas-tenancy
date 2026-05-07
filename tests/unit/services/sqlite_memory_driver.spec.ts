import { test } from '@japa/runner'
import SqliteMemoryDriver from '../../../src/services/isolation/sqlite_memory_driver.js'
import { setupTestConfig } from '../../helpers/config.js'

test.group('SqliteMemoryDriver — naming', (group) => {
  group.each.setup(() => setupTestConfig())

  test('reports its driver name', ({ assert }) => {
    const driver = new SqliteMemoryDriver()
    assert.equal(driver.name, 'sqlite-memory')
  })

  test('connectionName combines prefix from config with tenant id', ({ assert }) => {
    const driver = new SqliteMemoryDriver()
    assert.equal(driver.connectionName('abc'), 'tenant_abc')
  })

  test('honors a custom prefix coming from config overrides', ({ assert }) => {
    setupTestConfig({ tenantConnectionNamePrefix: 'sqlite_' })
    const driver = new SqliteMemoryDriver()
    assert.equal(driver.connectionName('1'), 'sqlite_1')
  })

  test('rejects unsafe identifiers in connectionName', ({ assert }) => {
    const driver = new SqliteMemoryDriver()
    assert.throws(() => driver.connectionName('../etc/passwd'), /unsafe tenant id/)
    assert.throws(() => driver.connectionName(''), /unsafe tenant id/)
  })
})
