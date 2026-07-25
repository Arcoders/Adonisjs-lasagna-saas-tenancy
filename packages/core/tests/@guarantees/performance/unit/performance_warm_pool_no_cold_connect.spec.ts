import { test } from '@japa/runner'
import PooledPgDriver from '../../../../src/services/isolation/pooled_pg_driver.js'
import { setConfig } from '../../../../src/config.js'
import { __resetConfigForTests } from '../../../../src/testing/config_reset.js'
import { testConfig } from '../../../helpers/config.js'
import type { TenantModelContract } from '../../../../src/types/contracts.js'

/**
 * F2 — warming erases the cold-connection cliff, pinned as an operation count.
 * The cliff is the FIRST connect for an idle tenant: it registers the connection
 * (a `manager.add`). Once warmed, a subsequent (request-path) connect for the same
 * tenant is a CACHE HIT: it resolves the already-registered connection with zero
 * additional registration ops. This is the driver-level invariant WarmPoolService
 * relies on.
 */

const A = '11111111-1111-4111-8111-111111111111'

function countingDb() {
  const conns = new Map<string, { config: any }>([['tenant', { config: { client: 'pg' } }]])
  let addCount = 0
  return {
    addCount: () => addCount,
    size: () => [...conns.keys()].filter((n) => n.startsWith('tenant_')).length,
    manager: {
      has: (n: string) => conns.has(n),
      get: (n: string) => conns.get(n),
      add: (n: string, config: any) => {
        addCount++
        conns.set(n, { config })
      },
      release: async (n: string) => {
        conns.delete(n)
      },
    },
    connection: (n: string) => ({ __name: n }),
  }
}

class TestPooledDriver extends PooledPgDriver {
  readonly name = 'schema-pg' as any
  #db: ReturnType<typeof countingDb>
  constructor(db: ReturnType<typeof countingDb>) {
    super({ label: 'warm-test' })
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

test.group('performance — a warmed tenant pays no cold-connect op', (group) => {
  group.each.setup(() => {
    __resetConfigForTests()
    setConfig({ ...testConfig, isolation: { driver: 'schema-pg' } } as any)
  })
  group.each.teardown(() => __resetConfigForTests())

  test('the first (warm) connect registers once; the next connect is a cache hit', async ({
    assert,
  }) => {
    const db = countingDb()
    const driver = new TestPooledDriver(db)

    // Warm: the cold cliff (one registration).
    await driver.connect(tenant(A), { bypassSoftCap: true })
    assert.equal(db.addCount(), 1, 'warming registers the connection once')
    assert.equal(db.size(), 1)

    // A subsequent request-path connect resolves the cached connection with NO
    // additional registration op: the cliff is gone for this warmed tenant.
    await driver.connect(tenant(A))
    assert.equal(db.addCount(), 1, 'a warmed tenant adds no second registration')
    assert.equal(db.size(), 1)
  })
})
