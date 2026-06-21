import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

// 10 tenants × 100 writes = 1000 shuffled cross-tenant writes. We fire them in
// bounded-concurrency batches rather than 1000 truly-simultaneous requests:
// each tenant has its own Lucid pool, so capping in-flight requests keeps
// per-tenant concurrency low (~2-3) and total open connections well under
// Postgres max_connections (10 pools is also under the soft LRU bound, and
// enforceConnectionCap is off by default). This budget assumes the other
// isolation specs release their tenant pools in teardown (driver.destroy ->
// disconnect, as cross_tenant_e2e does); these 10 pools stack on any a prior
// group leaves open.
const TENANT_COUNT = 10
const WRITES_PER_TENANT = 100
const CONCURRENCY = 25

/**
 * Concern 4: the high-volume sibling of cross_tenant_e2e.spec.ts. Same shape
 * (one private `posts` table per tenant schema, concurrent interleaved writes,
 * direct-DB read-back + HTTP read-back), scaled to ~1000 writes to stress the
 * schema-pg per-tenant pool routing under sustained contention. A single leaked
 * row — a request scoped to tenant A landing in tenant B's schema — fails the run.
 */
test.group('Cross-tenant isolation fuzz (~1000 writes)', (group) => {
  let driver: SchemaPgDriver
  const tenants: { id: string; index: number }[] = []

  async function findTenant(id: string): Promise<TenantModelContract> {
    const Tenant = (await import('../../fixtures/app/models/tenant.js')).default
    const t = await Tenant.find(id)
    if (!t) throw new Error(`tenant ${id} not found`)
    return t as unknown as TenantModelContract
  }

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(`Cross-tenant fuzz requires schema-pg driver (got '${active.name}')`)
    }
    driver = active as SchemaPgDriver

    for (let i = 0; i < TENANT_COUNT; i++) {
      const t = await createTestTenant({ status: 'active' })
      const tenant = await findTenant(t.id)
      await driver.provision(tenant)
      // searchPath is `tenant_<uuid>`, so the unqualified CREATE TABLE lands in
      // the tenant's own schema.
      await db.connection(`tenant_${t.id}`).rawQuery(`
        CREATE TABLE posts (
          id    serial PRIMARY KEY,
          title text NOT NULL
        )
      `)
      tenants.push({ id: t.id, index: i })
    }
  })

  group.teardown(async () => {
    while (tenants.length) {
      const t = tenants.pop()!
      await driver.destroy({ id: t.id } as any).catch(() => {})
      await destroyTestTenant(t.id).catch(() => {})
    }
  })

  test(`${TENANT_COUNT} tenants × ${WRITES_PER_TENANT} interleaved writes — zero cross-tenant leak`, async ({
    client,
    assert,
  }) => {
    // Flat, shuffled work list so the interleaving is non-deterministic.
    const writes: { tenantId: string; tenantIndex: number; postIndex: number }[] = []
    for (const t of tenants) {
      for (let p = 0; p < WRITES_PER_TENANT; p++) {
        writes.push({ tenantId: t.id, tenantIndex: t.index, postIndex: p })
      }
    }
    for (let i = writes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[writes[i], writes[j]] = [writes[j], writes[i]]
    }

    // Fire in bounded-concurrency batches (CONCURRENCY in flight at a time).
    for (let start = 0; start < writes.length; start += CONCURRENCY) {
      const batch = writes.slice(start, start + CONCURRENCY)
      const responses = await Promise.all(
        batch.map((w) =>
          client
            .post('/tenant/posts')
            .header('x-tenant-id', w.tenantId)
            .json({ title: `t${w.tenantIndex}-p${w.postIndex}` })
        )
      )
      for (const res of responses) res.assertStatus(200)
    }

    // Direct-DB verification (load-bearing, bypasses HTTP): each schema must hold
    // exactly its own rows and nothing foreign.
    for (const t of tenants) {
      const rows = await db.connection(`tenant_${t.id}`).from('posts').select('title').orderBy('id')
      assert.equal(
        rows.length,
        WRITES_PER_TENANT,
        `schema tenant_${t.id} must hold exactly ${WRITES_PER_TENANT} rows, got ${rows.length}`
      )
      for (const row of rows) {
        assert.match(
          row.title,
          new RegExp(`^t${t.index}-p\\d+$`),
          `LEAK: schema tenant_${t.id} (idx ${t.index}) holds foreign row "${row.title}"`
        )
      }
    }

    // HTTP read-back too, concurrent, to catch a stale-connection leak on the
    // read path (the e2e spec's technique, retained here at scale).
    const reads = tenants.flatMap((t) =>
      Array.from({ length: 2 }, () => client.get('/tenant/posts').header('x-tenant-id', t.id))
    )
    const readResponses = await Promise.all(reads)
    for (const res of readResponses) {
      res.assertStatus(200)
      const body = res.body() as { tenantId: string; posts: { title: string }[] }
      const ownIndex = tenants.find((t) => t.id === body.tenantId)?.index
      assert.isDefined(ownIndex, `unknown tenantId in response: ${body.tenantId}`)
      assert.equal(body.posts.length, WRITES_PER_TENANT)
      for (const post of body.posts) {
        assert.match(
          post.title,
          new RegExp(`^t${ownIndex}-p\\d+$`),
          `LEAK: tenant ${body.tenantId} (idx ${ownIndex}) saw foreign post "${post.title}"`
        )
      }
    }
  }).timeout(120_000)
})
