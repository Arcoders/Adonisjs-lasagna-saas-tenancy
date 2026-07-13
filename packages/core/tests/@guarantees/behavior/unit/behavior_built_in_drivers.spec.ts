import { test } from '@japa/runner'
import {
  BUILT_IN_ISOLATION_DRIVERS,
  BUILT_IN_ISOLATION_DRIVER_NAMES,
} from '../../../../src/services/isolation/built_in_drivers.js'
import { setupTestConfig, testConfig } from '../../../helpers/config.js'
import type { MultitenancyConfig } from '../../../../src/types/config.js'

/**
 * PLD-7: the built-in isolation drivers are a data-driven map so `boot()` does
 * not carry a per-driver branch. Pin the two properties the map must hold for
 * that to be safe: every key builds a driver that actually reports that name,
 * and the exported name list is exactly the map's keys.
 */
test.group('BUILT_IN_ISOLATION_DRIVERS', (group) => {
  group.each.setup(() => setupTestConfig())

  const cfg = testConfig as unknown as MultitenancyConfig

  test('every map key builds a driver whose name matches the key', ({ assert }) => {
    for (const [name, build] of Object.entries(BUILT_IN_ISOLATION_DRIVERS)) {
      const driver = build(cfg)
      assert.equal(driver.name, name, `factory for "${name}" produced driver "${driver.name}"`)
    }
  })

  test('the exported name list is exactly the map keys', ({ assert }) => {
    assert.deepEqual(
      [...BUILT_IN_ISOLATION_DRIVER_NAMES].sort(),
      Object.keys(BUILT_IN_ISOLATION_DRIVERS).sort()
    )
  })

  test('covers the four shipped built-ins', ({ assert }) => {
    assert.sameMembers(
      [...BUILT_IN_ISOLATION_DRIVER_NAMES],
      ['schema-pg', 'database-pg', 'rowscope-pg', 'sqlite-memory']
    )
  })

  test('database-pg factory threads the configured tenantDatabasePrefix through', ({ assert }) => {
    const withPrefix = {
      ...cfg,
      isolation: { ...(cfg.isolation ?? {}), tenantDatabasePrefix: 'app_db_' },
    } as MultitenancyConfig
    const driver = BUILT_IN_ISOLATION_DRIVERS['database-pg']!(withPrefix) as unknown as {
      databaseName(id: string): string
    }
    assert.equal(driver.databaseName('42'), 'app_db_42')
  })
})
