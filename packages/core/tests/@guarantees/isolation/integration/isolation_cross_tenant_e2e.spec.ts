import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

const TENANT_COUNT = 5
const POSTS_PER_TENANT = 20

/**
 * S0-3 (case 4.1): the load-bearing isolation test for the whole package.
 *
 * Spins up N real tenants, each with its own `tenant_<uuid>` schema and a
 * private `posts` table. Hammers the HTTP server with concurrent reads
 * and writes interleaved across tenants and asserts: a request scoped
 * to tenant A NEVER sees a row written by tenant B, even when their
 * pools are warm at the same time.
 *
 * If this test passes, we have empirical evidence that the schema-pg
 * driver + searchPath wiring + LRU pool genuinely isolates tenants
 * under contention. If it fails, we have a security-grade bug and the
 * package must not ship.
 */
test.group('Cross-tenant HTTP isolation under concurrency', (group) => {
  let driver: SchemaPgDriver
  const tenants: { id: string; index: number }[] = []

  async function findTenant(id: string): Promise<TenantModelContract> {
    const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
    const t = await Tenant.find(id)
    if (!t) throw new Error(`tenant ${id} not found`)
    return t as unknown as TenantModelContract
  }

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(
        `Cross-tenant isolation tests require schema-pg driver (got '${active.name}')`
      )
    }
    driver = active as SchemaPgDriver

    for (let i = 0; i < TENANT_COUNT; i++) {
      const t = await createTestTenant({ status: 'active' })
      const tenant = await findTenant(t.id)
      await driver.provision(tenant)
      // Create the per-tenant `posts` table. The connection's searchPath
      // is `tenant_<uuid>`, so the unqualified CREATE TABLE lands inside
      // the tenant's schema.
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

  test(`${TENANT_COUNT} tenants × ${POSTS_PER_TENANT} concurrent writes — no cross-tenant leak on read`, async ({
    client,
    assert,
  }) => {
    // Build a flat work list of (tenant, postIndex) write jobs and shuffle
    // it so the interleaving is non-deterministic across runs.
    const writes: { tenantId: string; tenantIndex: number; postIndex: number }[] = []
    for (const t of tenants) {
      for (let p = 0; p < POSTS_PER_TENANT; p++) {
        writes.push({ tenantId: t.id, tenantIndex: t.index, postIndex: p })
      }
    }
    for (let i = writes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[writes[i], writes[j]] = [writes[j]!, writes[i]!]
    }

    // Fire every write concurrently. Each row carries a tag that
    // includes the tenant index so we can detect leaks unambiguously
    // on read-back.
    const writeResponses = await Promise.all(
      writes.map((w) =>
        client
          .post('/tenant/posts')
          .header('x-tenant-id', w.tenantId)
          .json({ title: `t${w.tenantIndex}-p${w.postIndex}` })
      )
    )
    for (const res of writeResponses) {
      res.assertStatus(200)
    }

    // Now read back, also fully concurrent, multiple times per tenant
    // to widen the chance of catching a stale connection / pool leak.
    const reads = tenants.flatMap((t) =>
      Array.from({ length: 3 }, () => client.get('/tenant/posts').header('x-tenant-id', t.id))
    )
    const readResponses = await Promise.all(reads)

    for (const res of readResponses) {
      res.assertStatus(200)
      const body = res.body() as { tenantId: string; posts: { title: string }[] }

      // Every post returned must belong to this exact tenant. The title
      // tag's prefix encodes the tenant index — we look it up by id so
      // a typo in the route handler can't make this assertion vacuous.
      const ownIndex = tenants.find((t) => t.id === body.tenantId)?.index
      assert.isDefined(ownIndex, `unknown tenantId in response: ${body.tenantId}`)
      assert.equal(
        body.posts.length,
        POSTS_PER_TENANT,
        `tenant ${body.tenantId} should see exactly ${POSTS_PER_TENANT} posts, got ${body.posts.length}`
      )
      for (const post of body.posts) {
        assert.match(
          post.title,
          new RegExp(`^t${ownIndex}-p\\d+$`),
          `LEAK: tenant ${body.tenantId} (idx ${ownIndex}) saw post "${post.title}" from another tenant`
        )
      }
    }
  })

  test('writes are durable per-schema even when interleaved with other tenants', async ({
    assert,
  }) => {
    // Direct DB inspection: bypass the HTTP path and confirm each
    // tenant's schema contains exactly its own rows. This catches the
    // case where the HTTP layer happens to return clean data because
    // of memo coincidence, while the actual storage was crossed.
    for (const t of tenants) {
      const result = await db
        .connection(`tenant_${t.id}`)
        .from('posts')
        .select('title')
        .orderBy('id')
      assert.equal(
        result.length,
        POSTS_PER_TENANT,
        `direct read on schema tenant_${t.id} must show ${POSTS_PER_TENANT} rows`
      )
      for (const row of result) {
        assert.match(
          row.title,
          new RegExp(`^t${t.index}-p\\d+$`),
          `schema tenant_${t.id} has a row "${row.title}" that does not belong to tenant index ${t.index}`
        )
      }
    }
  })
})
