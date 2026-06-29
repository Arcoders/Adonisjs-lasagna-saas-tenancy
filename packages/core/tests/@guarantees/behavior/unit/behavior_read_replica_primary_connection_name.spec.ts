import { test } from '@japa/runner'
import SchemaPgDriver from '../../../../src/services/isolation/schema_pg_driver.js'
import RowScopePgDriver from '../../../../src/services/isolation/rowscope_pg_driver.js'
import { setupTestConfig, testConfig } from '../../../helpers/config.js'

/**
 * ReadReplicaService.resolve() clones the PRIMARY tenant connection's config to
 * build the replica connection, and looks the primary up by name. That name MUST
 * come from `driver.connectionName(tenant.id)`, not a hand-rolled
 * `${prefix}${id}`: for schema-pg the two are identical, but for rowscope-pg the
 * primary is the shared CENTRAL connection, so the hand-rolled name would miss
 * the manager and the replica would clone empty config (dropping pool/ssl/
 * searchPath). These assertions pin that divergence so the fix can't silently
 * regress.
 */
const TENANT_ID = '11111111-1111-4111-8111-111111111111'

test.group('ReadReplicaService primary-connection-name invariant', (group) => {
  group.each.setup(() => setupTestConfig())

  test('schema-pg names the primary `${prefix}${id}` — what resolve() needs to find it', ({
    assert,
  }) => {
    const driver = new SchemaPgDriver()
    assert.equal(
      driver.connectionName(TENANT_ID),
      `${testConfig.tenantConnectionNamePrefix}${TENANT_ID}`
    )
  })

  test('rowscope-pg names the primary the CENTRAL connection, not `${prefix}${id}`', ({
    assert,
  }) => {
    const driver = new RowScopePgDriver()
    assert.equal(driver.connectionName(TENANT_ID), testConfig.centralConnectionName)
    assert.notEqual(
      driver.connectionName(TENANT_ID),
      `${testConfig.tenantConnectionNamePrefix}${TENANT_ID}`,
      'the hand-rolled prefix+id name does NOT exist in the manager under rowscope-pg'
    )
  })
})
