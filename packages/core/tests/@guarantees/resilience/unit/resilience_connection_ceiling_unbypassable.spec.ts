import { test } from '@japa/runner'
import PooledPgDriver from '../../../../src/services/isolation/pooled_pg_driver.js'
import TenantConnectionLimitException from '../../../../src/exceptions/tenant_connection_limit_exception.js'
import { setConfig } from '../../../../src/config.js'
import { __resetConfigForTests } from '../../../../src/testing/config_reset.js'
import { testConfig } from '../../../helpers/config.js'
import type { TenantModelContract } from '../../../../src/types/contracts.js'

/**
 * S2 — the absolute connection ceiling is UNBYPASSABLE.
 *
 * Before this fix the admission check gated the ceiling behind the SAME bypass
 * flag as the soft cap (`if (!bypassHardCap && (atHardCeiling() || atHardLimit()))`),
 * so every operational path (provision, migrate, seed, doctor) that passed the
 * bypass skipped the "always-on" ceiling too. Any parallel/warm pool on that seam
 * would grow unbounded backends = a PostgreSQL-exhaustion DoS. The fix splits the
 * check: the ceiling ALWAYS throws; only the soft cap is bypassable
 * (`bypassSoftCap`).
 *
 * Driven against a fake Lucid manager (no real PG), so the admission ORDER is a
 * fast, gating unit invariant. The real-PG adversarial proof lives in
 * `@integration/fault_injection/ceiling_absolute_under_bypass.spec.ts`.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

function fakeDb() {
  const conns = new Map<string, { config: any }>([['tenant', { config: { client: 'pg' } }]])
  return {
    conns,
    manager: {
      has: (n: string) => conns.has(n),
      get: (n: string) => conns.get(n),
      add: (n: string, config: any) => conns.set(n, { config }),
      release: async (n: string) => {
        conns.delete(n)
      },
    },
    connection: (n: string) => ({ __name: n }),
  }
}

class TestPooledDriver extends PooledPgDriver {
  readonly name = 'schema-pg' as any
  #db: ReturnType<typeof fakeDb>
  constructor(db: ReturnType<typeof fakeDb>) {
    super({ label: 'test-pooled' })
    this.#db = db
  }
  protected async lucid() {
    return { db: this.#db as any }
  }
  protected buildTenantConfig(template: any, tenant: TenantModelContract) {
    return { ...template, searchPath: [`tenant_${tenant.id}`] }
  }
  protected verifyCachedConnection() {}
  async provision() {}
  async destroy() {}
  async reset() {}
  tableLocation() {
    return {} as any
  }
}

const tenant = (id: string) => ({ id }) as TenantModelContract

test.group('S2 — absolute connection ceiling is unbypassable', (group) => {
  group.each.setup(() => __resetConfigForTests())
  group.each.teardown(() => __resetConfigForTests())

  function configureCeiling(): void {
    setConfig({
      ...testConfig,
      isolation: {
        driver: 'schema-pg',
        // Soft cap OFF, so ONLY the absolute ceiling can bite. A ceiling of 1 and a
        // long grace window means the first connection is never evictable.
        enforceConnectionCap: false,
        maxTenantConnections: 50,
        maxTenantConnectionsHardCeiling: 1,
        evictionGracePeriodMs: 60_000,
      },
    } as any)
  }

  test('an operational bypassSoftCap connect is STILL refused at the ceiling, no leak', async ({
    assert,
  }) => {
    configureCeiling()
    const db = fakeDb()
    const driver = new TestPooledDriver(db)

    // A fills the single ceiling slot even though it bypasses the soft cap.
    await driver.connect(tenant(A), { bypassSoftCap: true })

    // B, also operational (bypassSoftCap), must be refused: the ceiling is
    // unbypassable. Before the fix, bypassSoftCap (then bypassHardCap) skipped it.
    let threw: unknown
    try {
      await driver.connect(tenant(B), { bypassSoftCap: true })
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, TenantConnectionLimitException)

    // No half-registered second connection was left behind.
    const prefix = testConfig.tenantConnectionNamePrefix ?? 'tenant_'
    assert.isFalse(db.conns.has(`${prefix}${B}`), 'a refused connection leaks no registration')
  })

  test('a request-path connect is refused at the ceiling too', async ({ assert }) => {
    configureCeiling()
    const db = fakeDb()
    const driver = new TestPooledDriver(db)
    await driver.connect(tenant(A), { bypassSoftCap: true })

    await assert.rejects(() => driver.connect(tenant(B)), TenantConnectionLimitException as any)
  })

  test('with no ceiling set, an operational bypass still admits (bypassSoftCap preserved)', async ({
    assert,
  }) => {
    setConfig({
      ...testConfig,
      isolation: {
        driver: 'schema-pg',
        // Soft cap ON at 1, but NO ceiling: the soft cap is what a bypass skips.
        enforceConnectionCap: true,
        maxTenantConnections: 1,
        evictionGracePeriodMs: 60_000,
      },
    } as any)
    const db = fakeDb()
    const driver = new TestPooledDriver(db)

    await driver.connect(tenant(A), { bypassSoftCap: true })
    // A request-path connect hits the soft cap and is refused...
    await assert.rejects(() => driver.connect(tenant(B)), TenantConnectionLimitException as any)
    // ...but an operational path bypasses the SOFT cap and is admitted.
    const client = await driver.connect(tenant(B), { bypassSoftCap: true })
    assert.isDefined(client, 'bypassSoftCap still lets an operational path exceed the soft cap')
  })
})
