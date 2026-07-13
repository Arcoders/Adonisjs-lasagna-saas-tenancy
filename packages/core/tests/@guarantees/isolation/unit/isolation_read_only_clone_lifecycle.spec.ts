import { test } from '@japa/runner'
import { setConfig } from '../../../../src/config.js'
import { testConfig } from '../../../helpers/config.js'
import SchemaPgDriver from '../../../../src/services/isolation/schema_pg_driver.js'
import IsolationConfigException from '../../../../src/exceptions/isolation_config_exception.js'

/**
 * AD-01 — the driver owns the read-only firewall clone.
 *
 * The `__plugin_ro` clone used to be built by the adapter and NEVER released:
 * a multi-tenant process running untrusted plugin code leaked one pool per
 * tenant. The driver now owns it — built by `ensureReadOnlyClient`, tracked in
 * the SAME pool as the primary, and RELEASED on `disconnect`. These pin that
 * ownership without a live database, by driving a manager double through the
 * driver's own lifecycle.
 */

const UUID = '11111111-1111-4111-8111-111111111111'

/** A manager double that records add/release so the pool bookkeeping is observable. */
function makeDb() {
  const registered = new Set<string>()
  const released: string[] = []
  const added: Record<string, any> = {}
  const manager = {
    has: (n: string) => registered.has(n),
    get: (n: string) => (registered.has(n) ? { config: added[n] } : undefined),
    add: (n: string, c: any) => {
      added[n] = c
      registered.add(n)
    },
    release: async (n: string) => {
      registered.delete(n)
      released.push(n)
    },
  }
  return {
    registered,
    released,
    added,
    manager,
    connection: (n: string) => ({ name: n }),
  }
}

/** SchemaPgDriver whose async `lucid()` (used by disconnect) resolves to the double. */
function driverOver(mockDb: ReturnType<typeof makeDb>) {
  return new (class extends SchemaPgDriver {
    protected async lucid() {
      return { db: mockDb as any }
    }
  })()
}

test.group('AD-01 — read-only firewall clone lifecycle', (group) => {
  group.each.setup(() => setConfig({ ...testConfig }))

  test('the clone is released on disconnect, closing the per-tenant pool leak', async ({
    assert,
  }) => {
    const mockDb = makeDb()
    const driver = driverOver(mockDb)
    const primary = driver.connectionName(UUID)
    const roName = driver.readOnlyConnectionName(UUID)
    // The primary is established first (context entry does this), then an untrusted
    // query establishes the read-only clone.
    mockDb.manager.add(primary, {
      searchPath: [driver.schemaName(UUID)],
      connection: { user: 'app' },
    })
    driver.ensureReadOnlyClient(UUID, mockDb as any, { user: 'plugin_ro' })
    assert.isTrue(mockDb.registered.has(roName), 'the clone is registered on first use')

    await driver.disconnect({ id: UUID } as any)

    assert.isFalse(mockDb.registered.has(roName), 'the clone is released on disconnect (no leak)')
    assert.isFalse(mockDb.registered.has(primary), 'the primary is released too')
    assert.includeMembers(mockDb.released, [primary, roName])
  })

  test('the clone is registered once and reused on a second untrusted query', ({ assert }) => {
    const mockDb = makeDb()
    const driver = driverOver(mockDb)
    const primary = driver.connectionName(UUID)
    mockDb.manager.add(primary, {
      searchPath: [driver.schemaName(UUID)],
      connection: { user: 'app' },
    })
    let adds = 0
    const origAdd = mockDb.manager.add
    mockDb.manager.add = (n: string, c: any) => {
      adds++
      origAdd(n, c)
    }
    driver.ensureReadOnlyClient(UUID, mockDb as any, { user: 'plugin_ro' })
    driver.ensureReadOnlyClient(UUID, mockDb as any, { user: 'plugin_ro' })
    assert.equal(adds, 1, 'the read-only clone is added exactly once')
  })

  test('fails CLOSED when the primary is not established (never hands back a client)', ({
    assert,
  }) => {
    const mockDb = makeDb() // primary NOT registered
    const driver = driverOver(mockDb)
    assert.throws(
      () => driver.ensureReadOnlyClient(UUID, mockDb as any, { user: 'plugin_ro' }),
      IsolationConfigException
    )
    assert.isFalse(
      mockDb.registered.has(driver.readOnlyConnectionName(UUID)),
      'no clone is registered when the primary is missing'
    )
  })

  test('seals the primary before cloning: refuses a primary pinned to another schema', ({
    assert,
  }) => {
    const mockDb = makeDb()
    const driver = driverOver(mockDb)
    const primary = driver.connectionName(UUID)
    // A primary whose searchPath is NOT this tenant's schema (stale/collided
    // registration): cloning it read-only would expose another tenant's data.
    mockDb.manager.add(primary, {
      searchPath: ['tenant_someone_else'],
      connection: { user: 'app' },
    })
    assert.throws(
      () => driver.ensureReadOnlyClient(UUID, mockDb as any, { user: 'plugin_ro' }),
      IsolationConfigException
    )
    assert.isFalse(
      mockDb.registered.has(driver.readOnlyConnectionName(UUID)),
      'no clone is built from a mis-pinned primary'
    )
  })
})
