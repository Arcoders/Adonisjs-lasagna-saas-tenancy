import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import {
  ReadReplicaService,
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

async function findTenant(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
  const t = await Tenant.find(id)
  if (!t) throw new Error(`tenant ${id} not found`)
  return t as unknown as TenantModelContract
}

/**
 * ReadReplicaService.resolve() against real Postgres. Validates the replica
 * connection is correctly built (host override, search path preserved) and that
 * an unreachable replica fails loudly rather than silently routing to the
 * primary. The package does NOT do automatic failover, by design, and consumers
 * must know that.
 */
test.group('ReadReplicaService — resolve() against real PG', (group) => {
  let originalConfig: ReturnType<typeof getConfig>
  let driver: SchemaPgDriver
  const cleanup: { tenantId: string; connNames: string[] }[] = []

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(`requires schema-pg driver (got '${active.name}')`)
    }
    driver = active as SchemaPgDriver
  })

  group.each.setup(() => {
    originalConfig = getConfig()
  })

  group.each.teardown(async () => {
    setConfig(originalConfig)
    while (cleanup.length) {
      const c = cleanup.pop()!
      for (const name of c.connNames) {
        if (db.manager.has(name)) await db.manager.release(name).catch(() => {})
      }
      await driver.destroy({ id: c.tenantId } as any).catch(() => {})
      await destroyTestTenant(c.tenantId).catch(() => {})
    }
  })

  test('resolve() returns a connection whose search_path targets the tenant schema (real reachable replica)', async ({
    assert,
  }) => {
    // Single-host test: use the same PG we already have as a "fake replica" with
    // a reachable host. The point of this test is to prove the replica
    // connection inherits the tenant's search_path. A bug that nests `searchPath`
    // under `connection` (which knex ignores) silently routes every read to the
    // default `public` schema, a cross-tenant leak. A bare `SELECT 1` would NOT
    // catch that; reading a table that only exists inside the tenant schema does.
    // Reuse the configured primary DB host/port as a "fake replica" target. Read
    // from env (the fixture's database.ts uses the same DB_HOST/DB_PORT) so this
    // does not depend on a `backup` config block, which now lives in the backup
    // satellite rather than core's MultitenancyConfig.
    const baseConn = {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
    }
    setConfig({
      ...originalConfig,
      tenantReadReplicas: {
        strategy: 'round-robin',
        hosts: [{ host: baseConn.host, port: baseConn.port, name: 'fake-replica-self' }],
      },
    })

    const t = await createTestTenant({ status: 'provisioning' })
    const tenant = await findTenant(t.id)
    await driver.provision(tenant)
    const replicaConn = `tenant_${t.id}_read_0`
    cleanup.push({ tenantId: t.id, connNames: [replicaConn, `tenant_${t.id}`] })

    // Create a table and row INSIDE the tenant schema via the PRIMARY tenant
    // connection (its search_path already points at tenant_<uuid>).
    const primary = await driver.connect(tenant)
    await primary.rawQuery(
      'CREATE TABLE IF NOT EXISTS replica_probe (id int primary key, marker text)'
    )
    await primary.rawQuery("INSERT INTO replica_probe (id, marker) VALUES (1, 'tenant-scoped')")

    const svc = new ReadReplicaService()
    const conn = await svc.resolve(tenant)
    assert.isNotNull(conn, 'resolve must return a connection when replicas are configured')
    assert.equal((conn as any).connectionName, replicaConn)

    // The replica must resolve the UNQUALIFIED table name through the tenant
    // search_path. If search_path defaulted to `public`, this throws
    // `relation "replica_probe" does not exist`.
    const result = await conn!.rawQuery('SELECT marker FROM replica_probe WHERE id = 1')
    const rows = Array.isArray(result.rows) ? result.rows : (result as any).rows
    assert.equal(rows[0].marker, 'tenant-scoped')

    // And prove the search_path explicitly so the intent can't regress to a
    // path-independent assertion.
    const sp = await conn!.rawQuery('SHOW search_path')
    const spRows = Array.isArray(sp.rows) ? sp.rows : (sp as any).rows
    assert.include(
      String(spRows[0].search_path),
      tenant.schemaName,
      'replica search_path must include the tenant schema, not just public'
    )
  })

  test('resolve() returns a connection that THROWS on query when the replica is unreachable', async ({
    assert,
  }) => {
    setConfig({
      ...originalConfig,
      tenantReadReplicas: {
        strategy: 'round-robin',
        hosts: [{ host: '127.0.0.1', port: 1, name: 'unreachable-replica' }],
      },
    })

    const t = await createTestTenant({ status: 'provisioning' })
    const tenant = await findTenant(t.id)
    await driver.provision(tenant)
    const svc = new ReadReplicaService()
    const replicaConn = `tenant_${t.id}_read_0`
    cleanup.push({ tenantId: t.id, connNames: [replicaConn, `tenant_${t.id}`] })

    const conn = await svc.resolve(tenant)
    assert.isNotNull(conn, 'resolve must return a connection regardless of replica health')
    // The query is what surfaces the failure. There is NO automatic
    // failover to the primary. Apps that need failover must catch this
    // and retry against the primary themselves.
    let caughtErr: any = null
    try {
      await conn!.rawQuery('SELECT 1')
    } catch (err) {
      caughtErr = err
    }
    assert.isNotNull(
      caughtErr,
      'unreachable replica must fail at query time (no silent fallback to primary)'
    )
    assert.match(
      String(caughtErr?.message ?? caughtErr),
      /ECONNREFUSED|connect|connection|EAI_AGAIN/i
    )
  })

  test('sticky strategy returns the same replica index for the same tenant id across calls', ({
    assert,
  }) => {
    setConfig({
      ...originalConfig,
      tenantReadReplicas: {
        strategy: 'sticky',
        hosts: [
          { host: '127.0.0.1', port: 5432, name: 'r0' },
          { host: '127.0.0.1', port: 5432, name: 'r1' },
          { host: '127.0.0.1', port: 5432, name: 'r2' },
        ],
      },
    })

    const id1 = randomUUID()
    const id2 = randomUUID()
    const svc = new ReadReplicaService()

    const a = svc.pickIndex(id1)
    const b = svc.pickIndex(id1)
    const c = svc.pickIndex(id1)
    assert.equal(a, b)
    assert.equal(b, c)

    // Different tenant must (eventually, for at least *some* pair)
    // route somewhere different. Otherwise sticky is broken or the
    // hash is degenerate. We can't assert "always different" because a
    // hash collision is mathematically possible, but in 100 trials the
    // distribution must show at least 2 distinct indices overall.
    const seen = new Set<number>([a!])
    for (let i = 0; i < 100; i++) {
      seen.add(svc.pickIndex(randomUUID()) ?? -1)
    }
    assert.isAtLeast(seen.size, 2, 'sticky strategy must spread across replicas in aggregate')

    // And calling for id2 again returns the same index as the first call.
    const x = svc.pickIndex(id2)
    const y = svc.pickIndex(id2)
    assert.equal(x, y)
  })

  test('round-robin advances the cursor across distinct calls', ({ assert }) => {
    setConfig({
      ...originalConfig,
      tenantReadReplicas: {
        strategy: 'round-robin',
        hosts: [
          { host: '127.0.0.1', port: 5432, name: 'r0' },
          { host: '127.0.0.1', port: 5432, name: 'r1' },
          { host: '127.0.0.1', port: 5432, name: 'r2' },
        ],
      },
    })
    const svc = new ReadReplicaService()
    svc.resetCursor()
    const ids = Array.from({ length: 6 }, () => svc.pickIndex(randomUUID()))
    assert.deepEqual(ids, [0, 1, 2, 0, 1, 2], 'round-robin must wrap predictably')
  })

  test('pickIndex returns null when no replicas are configured', ({ assert }) => {
    setConfig({ ...originalConfig, tenantReadReplicas: undefined as any })
    const svc = new ReadReplicaService()
    assert.isNull(svc.pickIndex(randomUUID()))
    assert.isNull(svc.pickHost(randomUUID()))
  })
})
