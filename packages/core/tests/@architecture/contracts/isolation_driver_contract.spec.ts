import { test } from '@japa/runner'
import { setConfig } from '../../../src/config.js'
import { testConfig } from '../../helpers/config.js'
import SchemaPgDriver from '../../../src/services/isolation/schema_pg_driver.js'
import DatabasePgDriver from '../../../src/services/isolation/database_pg_driver.js'
import SqliteMemoryDriver from '../../../src/services/isolation/sqlite_memory_driver.js'
import RowScopePgDriver from '../../../src/services/isolation/rowscope_pg_driver.js'
import { isProvisionableDriver } from '../../../src/services/isolation/driver.js'

/**
 * WS-5 / driver-contract-leaky-rowscope-noops.
 *
 * The single `IsolationDriver` interface forced every driver to implement
 * provisioning, so rowscope-pg shipped a `provision()` no-op that lied (returned
 * success while creating nothing). The contract is now split: enforcement
 * (`enforce`) is required of all drivers, and storage creation (`provision`)
 * lives on the optional `ProvisionableDriver`. A driver that owns no per-tenant
 * storage simply does not implement provision, and `isProvisionableDriver()`
 * tells callers which capability is present.
 *
 * RED (pre-fix): no driver declared `enforce`; rowscope faked `provision`;
 * `isProvisionableDriver` did not exist (the import fails to resolve).
 */
test.group('architectural — isolation driver contract', (group) => {
  group.each.setup(() => setConfig({ ...testConfig }))

  const allDrivers = () => ({
    'schema-pg': new SchemaPgDriver(),
    'database-pg': new DatabasePgDriver(),
    'sqlite-memory': new SqliteMemoryDriver(),
    'rowscope-pg': new RowScopePgDriver(),
  })

  test('every driver declares enforce() and a numeric contractVersion', ({ assert }) => {
    for (const [name, d] of Object.entries(allDrivers())) {
      assert.isFunction((d as any).enforce, `${name} must declare enforce()`)
      assert.isNumber((d as any).contractVersion, `${name} must declare contractVersion`)
    }
  })

  test('storage-owning drivers are provisionable; rowscope-pg is not', ({ assert }) => {
    const d = allDrivers()
    assert.isTrue(isProvisionableDriver(d['schema-pg']), 'schema-pg owns storage')
    assert.isTrue(isProvisionableDriver(d['database-pg']), 'database-pg owns storage')
    assert.isTrue(isProvisionableDriver(d['sqlite-memory']), 'sqlite-memory owns storage')
    // rowscope-pg shares the central tables: it must NOT fake a provision step.
    assert.isFalse(isProvisionableDriver(d['rowscope-pg']), 'rowscope-pg owns no storage')
    assert.isUndefined((d['rowscope-pg'] as any).provision)
  })

  test('detector control: the guard is not vacuously true', ({ assert }) => {
    assert.isTrue(isProvisionableDriver({ provision: async () => {} } as any))
    assert.isFalse(isProvisionableDriver({} as any))
    assert.isFalse(isProvisionableDriver({ provision: 'nope' } as any))
  })
})
