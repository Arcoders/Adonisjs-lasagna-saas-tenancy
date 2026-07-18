import { test } from '@japa/runner'
import WarmPoolService from '../../../../src/services/isolation/warm_pool_service.js'
import TenantConnectionLimitException from '../../../../src/exceptions/tenant_connection_limit_exception.js'
import { setConfig } from '../../../../src/config.js'
import { __resetConfigForTests } from '../../../../src/testing/config_reset.js'
import { testConfig } from '../../../helpers/config.js'
import type { TenantModelContract } from '../../../../src/types/contracts.js'
import type { WarmPoolConfig } from '../../../../src/types/config/isolation.js'

/**
 * F2 — WarmPoolService behavior. The service warms ONLY the operator-declared
 * tenants (a static list or the `selectTenants` hook, never request input),
 * through the capped `connect()` on the operational path (`bypassSoftCap`), and
 * fails closed: a per-tenant warm failure is skipped, not thrown.
 */

function fakeDriver(failIds: Set<string> = new Set()) {
  const connects: Array<{ id: string; bypassSoftCap: boolean | undefined }> = []
  const queries: string[] = []
  const driver = {
    async connect(tenant: TenantModelContract, opts?: { bypassSoftCap?: boolean }) {
      connects.push({ id: tenant.id, bypassSoftCap: opts?.bypassSoftCap })
      if (failIds.has(tenant.id)) throw new TenantConnectionLimitException()
      return {
        rawQuery: async (sql: string) => {
          queries.push(`${tenant.id}:${sql}`)
        },
      }
    },
  }
  return { driver: driver as any, connects, queries }
}

const models = (ids: string[]): TenantModelContract[] =>
  ids.map((id) => ({ id }) as TenantModelContract)

function configureWarmPool(warmPool: WarmPoolConfig | undefined): void {
  __resetConfigForTests()
  setConfig({ ...testConfig, isolation: { driver: 'schema-pg', warmPool } } as any)
}

test.group('WarmPoolService (F2)', (group) => {
  group.each.teardown(() => __resetConfigForTests())

  test('disabled: warms nothing', async ({ assert }) => {
    configureWarmPool({ enabled: false, tenants: ['a', 'b'] })
    const { driver, connects } = fakeDriver()
    const result = await new WarmPoolService({
      getDriver: async () => driver,
      listTenants: async (ids) => models(ids),
    }).warmAll()

    assert.isFalse(result.enabled)
    assert.lengthOf(connects, 0, 'a disabled warm pool never connects')
  })

  test('warms exactly the declared tenants, on the operational path', async ({ assert }) => {
    configureWarmPool({ enabled: true, tenants: ['a', 'b'] })
    const { driver, connects, queries } = fakeDriver()
    const result = await new WarmPoolService({
      getDriver: async () => driver,
      listTenants: async (ids) => models(ids),
    }).warmAll()

    assert.deepEqual(result, { enabled: true, requested: 2, warmed: 2, failed: 0 })
    assert.deepEqual(
      connects.map((c) => c.id).sort(),
      ['a', 'b'],
      'exactly the declared tenants were warmed'
    )
    assert.isTrue(connects.every((c) => c.bypassSoftCap === true), 'warming is an operational path')
    assert.deepEqual(queries.sort(), ['a:SELECT 1', 'b:SELECT 1'], 'each warmed with a trivial query')
  })

  test('count pre-opens N connections per tenant', async ({ assert }) => {
    configureWarmPool({ enabled: true, tenants: ['a'], count: 3 })
    const { driver, queries } = fakeDriver()
    await new WarmPoolService({
      getDriver: async () => driver,
      listTenants: async (ids) => models(ids),
    }).warmAll()

    assert.lengthOf(
      queries.filter((q) => q === 'a:SELECT 1'),
      3,
      'count=3 issues three warming queries'
    )
  })

  test('the selectTenants hook overrides the static list', async ({ assert }) => {
    configureWarmPool({
      enabled: true,
      tenants: ['ignored'],
      selectTenants: () => ['x', 'y'],
    })
    const { driver, connects } = fakeDriver()
    await new WarmPoolService({
      getDriver: async () => driver,
      listTenants: async (ids) => models(ids),
    }).warmAll()

    assert.deepEqual(
      connects.map((c) => c.id).sort(),
      ['x', 'y'],
      'the hook set is warmed, not the static list'
    )
  })

  test('fails closed: one tenant refused (ceiling) never aborts the batch', async ({ assert }) => {
    configureWarmPool({ enabled: true, tenants: ['a', 'b', 'c'] })
    const { driver, connects } = fakeDriver(new Set(['b']))
    const result = await new WarmPoolService({
      getDriver: async () => driver,
      listTenants: async (ids) => models(ids),
    }).warmAll()

    assert.deepEqual(result, { enabled: true, requested: 3, warmed: 2, failed: 1 })
    assert.deepEqual(connects.map((c) => c.id).sort(), ['a', 'b', 'c'], 'all were attempted')
  })
})
