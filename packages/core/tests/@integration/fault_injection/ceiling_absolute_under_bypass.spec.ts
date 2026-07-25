import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantConnectionLimitException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { createTestTenant, destroyTestTenant } from '../../helpers/tenant.js'

/**
 * Fault-injection tier (@integration/fault_injection) — S2: the absolute
 * connection ceiling is UNBYPASSABLE.
 *
 * `maxTenantConnectionsHardCeiling` is the last-resort DoS backstop against
 * PostgreSQL `max_connections` exhaustion. It used to sit behind the SAME bypass
 * flag as the soft cap, so every operational path (provision, migrate, seed,
 * doctor) that passed the bypass skipped it too. This spec proves the fix: even
 * an OPERATIONAL connect (`bypassSoftCap: true`) and an operational `migrate()`
 * are refused with the typed `TenantConnectionLimitException` (503) once the
 * ceiling is reached, and leave no half-registered connection behind. A parallel
 * or warm pool on this seam can therefore never grow the pool past the ceiling.
 *
 * Soft cap is OFF here (`enforceConnectionCap: false`), so the ONLY thing that can
 * refuse a connection is the absolute ceiling — the strongest form of the proof.
 * Imports follow the @integration convention (public subpaths → compiled ./build).
 */
const TENANT_CONNECTION_LIMIT_CODE = 'E_TENANT_CONNECTION_LIMIT'

async function clearTenantConnections(driver: SchemaPgDriver): Promise<void> {
  const prefix = getConfig().tenantConnectionNamePrefix
  const manager: any = (db as any).manager
  const names: string[] = []
  for (const [name] of manager.connections) {
    if (String(name).startsWith(prefix)) names.push(String(name))
  }
  for (const name of names) {
    await driver.disconnect({ id: name.slice(prefix.length) } as any)
  }
}

function openTenantConnections(): number {
  const prefix = getConfig().tenantConnectionNamePrefix
  const manager: any = (db as any).manager
  let count = 0
  for (const [name] of manager.connections) {
    if (String(name).startsWith(prefix)) count++
  }
  return count
}

test.group(
  'SchemaPgDriver — absolute ceiling under an operational bypass (fault injection)',
  (group) => {
    let savedConfig: any
    let driver: SchemaPgDriver

    group.setup(async () => {
      const reg = await app.container.make(IsolationDriverRegistry)
      const active = reg.active()
      if (active.name !== 'schema-pg') {
        throw new Error(`ceiling fault test requires schema-pg driver (got '${active.name}')`)
      }
      driver = active as SchemaPgDriver
    })

    group.each.setup(async () => {
      savedConfig = getConfig()
      setConfig({
        ...savedConfig,
        isolation: {
          ...(savedConfig.isolation ?? { driver: 'schema-pg' }),
          driver: 'schema-pg',
          // Soft cap OFF: only the absolute ceiling can refuse. Ceiling of 1 + long
          // grace means the first connection is never evictable, so the second
          // distinct tenant hits the ceiling.
          enforceConnectionCap: false,
          maxTenantConnectionsHardCeiling: 1,
          evictionGracePeriodMs: 60_000,
        },
      })
      await clearTenantConnections(driver)
    })

    group.each.teardown(async () => {
      await clearTenantConnections(driver)
      setConfig(savedConfig)
    })

    test('an operational bypassSoftCap connect over the ceiling is refused with a 503, no leak', async ({
      assert,
    }) => {
      const a = await createTestTenant({ status: 'active' })
      const b = await createTestTenant({ status: 'active' })
      try {
        const tenantA = { id: a.id } as unknown as TenantModelContract
        await driver.provision(tenantA)
        assert.equal(openTenantConnections(), 1, 'A occupies the single ceiling slot')

        // B connects on an OPERATIONAL path (bypassSoftCap). The ceiling is
        // unbypassable, so this must throw the typed 503 even though the soft cap is
        // bypassed. Before the fix, the bypass skipped the ceiling and B would open
        // a second real backend.
        const tenantB = { id: b.id } as unknown as TenantModelContract
        let threw: any
        try {
          await driver.connect(tenantB, { bypassSoftCap: true } as any)
        } catch (error) {
          threw = error
        }
        assert.instanceOf(
          threw,
          TenantConnectionLimitException,
          `expected TenantConnectionLimitException, got ${threw?.code ?? threw?.message}`
        )
        assert.equal(threw?.code, TENANT_CONNECTION_LIMIT_CODE)
        assert.equal(threw?.status, 503)

        assert.equal(
          openTenantConnections(),
          1,
          'a refused operational connection leaks no second registration'
        )
      } finally {
        await driver.destroy({ id: a.id } as unknown as TenantModelContract).catch(() => {})
        await driver.destroy({ id: b.id } as unknown as TenantModelContract).catch(() => {})
        await destroyTestTenant(a.id)
        await destroyTestTenant(b.id)
      }
    })

    test('migrate() (an operational self-connect) is also refused at the ceiling', async ({
      assert,
    }) => {
      const a = await createTestTenant({ status: 'active' })
      const b = await createTestTenant({ status: 'active' })
      try {
        const tenantA = { id: a.id } as unknown as TenantModelContract
        await driver.provision(tenantA)
        assert.equal(openTenantConnections(), 1, 'A occupies the single ceiling slot')

        // migrate() self-connects with bypassSoftCap. The ceiling still applies, so
        // an operational migration cannot exhaust the database either.
        const tenantB = { id: b.id } as unknown as TenantModelContract
        await assert.rejects(
          () => driver.migrate(tenantB, { direction: 'up' } as any),
          TenantConnectionLimitException as any
        )
        assert.equal(openTenantConnections(), 1, 'the refused migrate leaks no registration')
      } finally {
        await driver.destroy({ id: a.id } as unknown as TenantModelContract).catch(() => {})
        await driver.destroy({ id: b.id } as unknown as TenantModelContract).catch(() => {})
        await destroyTestTenant(a.id)
        await destroyTestTenant(b.id)
      }
    })
  }
)
