import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { ReadReplicaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { createInstalledTenant, dropAllTenants } from './_helpers.js'

interface MultitenancyCfg {
  tenantReadReplicas?: {
    hosts: Array<{ host: string; port?: number; name?: string }>
    strategy?: 'round-robin' | 'random' | 'sticky'
    connectionSuffix?: string
  }
}

async function getCurrentConfig(): Promise<any> {
  // The package's `setConfig()` is the only writer; the demo's
  // config/multitenancy.ts is the original source of truth. Re-importing it
  // gives us the snapshot to mutate + restore.
  const mod = await import('#config/multitenancy')
  return mod.default as any
}

function indexFromConnectionName(connectionName: string): number | null {
  const m = connectionName.match(/_read_(\d+)$/)
  return m ? Number(m[1]) : null
}

/**
 * Validates the three read-replica strategies.
 *
 *   sticky:      same tenant always lands on the same index (covered in
 *                full.spec.ts). Re-asserted here for completeness with the
 *                multi-replica config.
 *   round-robin: over N requests, all replica indices appear at least once.
 *   random:      over N requests, all replica indices appear at least once.
 *
 * Distribution is observed via the connection name `tenant_<id>_read_<idx>`
 * returned by /demo/notes/read.
 */
test.group('e2e — read replica strategies', (group) => {
  const originalConfig: any = {}
  const REPLICA_COUNT = 3
  const HOST = process.env.DB_HOST ?? '127.0.0.1'

  group.setup(async () => {
    await dropAllTenants()
    Object.assign(originalConfig, await getCurrentConfig())
  })

  group.teardown(async () => {
    // Restore the original config so subsequent test files run untouched.
    setConfig(originalConfig as any)
    await dropAllTenants()
  })

  // Each test sets its own strategy via setConfig().
  function applyConfig(strategy: 'round-robin' | 'random' | 'sticky') {
    const next = {
      ...originalConfig,
      tenantReadReplicas: {
        hosts: Array.from({ length: REPLICA_COUNT }, (_, i) => ({
          host: HOST,
          name: `replica-${i}`,
        })),
        strategy,
        connectionSuffix: '_read',
      },
    }
    setConfig(next as any)
  }

  test('sticky strategy lands the same tenant on the same replica index', async ({
    client,
    assert,
  }) => {
    applyConfig('sticky')
    const { id } = await createInstalledTenant(client)

    const observed = new Set<number>()
    for (let i = 0; i < 6; i++) {
      const r = await client.get('/demo/notes/read').header('x-tenant-id', id)
      r.assertStatus(200)
      const idx = indexFromConnectionName(r.body().readFrom)
      assert.isNotNull(idx, 'connection name should encode replica index')
      observed.add(idx!)
    }
    assert.equal(observed.size, 1, 'sticky strategy should always pick the same index')
  })

  test('round-robin strategy distributes across all replicas over N requests', async ({
    client,
    assert,
  }) => {
    applyConfig('round-robin')
    const svc = await app.container.make(ReadReplicaService)
    svc.resetCursor()

    const { id } = await createInstalledTenant(client)

    const seen = new Set<number>()
    for (let i = 0; i < 12; i++) {
      const r = await client.get('/demo/notes/read').header('x-tenant-id', id)
      r.assertStatus(200)
      const idx = indexFromConnectionName(r.body().readFrom)
      if (idx !== null) seen.add(idx)
    }
    assert.equal(
      seen.size,
      REPLICA_COUNT,
      'round-robin should hit every replica over enough requests'
    )
  })

  test('random strategy distributes across all replicas over N requests', async ({
    client,
    assert,
  }) => {
    applyConfig('random')
    const { id } = await createInstalledTenant(client)

    const seen = new Set<number>()
    for (let i = 0; i < 60; i++) {
      const r = await client.get('/demo/notes/read').header('x-tenant-id', id)
      r.assertStatus(200)
      const idx = indexFromConnectionName(r.body().readFrom)
      if (idx !== null) seen.add(idx)
    }
    assert.equal(
      seen.size,
      REPLICA_COUNT,
      'random should hit every replica with high probability over 60 requests'
    )
  })

  test('pickIndex() returns null when no replicas are configured', async ({ assert }) => {
    setConfig({ ...originalConfig, tenantReadReplicas: undefined } as any)
    const svc = new ReadReplicaService()
    assert.isNull(svc.pickIndex('any-tenant-id'))
  })

  test('connectionName encodes the index and prefix', ({ assert }) => {
    applyConfig('sticky')
    const svc = new ReadReplicaService()
    const name = svc.connectionName('aaaa-bbbb', 2)
    assert.match(name, /_read_2$/)
    assert.match(name, /^tenant_aaaa-bbbb/)
  })
})
