import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { IsthmusGuardTripped } from '@adonisjs-lasagna/saas-tenancy/events'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The Isthmus ContextSeal, end-to-end over real HTTP + PG (invariant I1: never
 * route tenant A's queries under tenant B's context):
 *
 *  - a guarded request whose handler enters `tenancy.run(otherTenant)` before a
 *    model query gets the typed E_ISTHMUS_TENANT_MISMATCH 500 AND the critical
 *    `isthmus:seal:tenant:mismatch` event — never the other tenant's data;
 *  - the normal guarded path (scope agrees with the request) is byte-for-byte
 *    unaffected;
 *  - the job path (`tenancy.run` with no HttpContext) is inert — the seal only
 *    exists where two context sources can disagree.
 */

async function findTenant(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
  const t = await Tenant.find(id)
  if (!t) throw new Error(`tenant ${id} not found`)
  return t as unknown as TenantModelContract
}

test.group('ContextSeal — tenant-context mismatch fails closed', (group) => {
  let driver: SchemaPgDriver
  let tenantA: { id: string }
  let tenantB: { id: string }

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    driver = reg.active() as SchemaPgDriver

    // Tenant A gets a real schema + posts table (its queries must succeed).
    tenantA = await createTestTenant({ status: 'active' })
    await driver.provision(await findTenant(tenantA.id))
    await db.connection(`tenant_${tenantA.id}`).rawQuery(`
      CREATE TABLE posts (
        id    serial PRIMARY KEY,
        title text NOT NULL
      )
    `)
    // Tenant B only needs to exist in the registry: the seal must refuse the
    // mismatched query BEFORE anything routes to B's (never-provisioned) schema.
    tenantB = await createTestTenant({ status: 'active' })
  })

  group.teardown(async () => {
    await driver.destroy({ id: tenantA.id } as any).catch(() => {})
    await destroyTestTenant(tenantA.id).catch(() => {})
    await destroyTestTenant(tenantB.id).catch(() => {})
  })

  test('tenancy.run(otherTenant) inside a guarded request → typed 500 + critical event', async ({
    client,
    assert,
  }) => {
    const tripped: InstanceType<typeof IsthmusGuardTripped>[] = []
    const emitter = await app.container.make('emitter')
    const listener = (event: InstanceType<typeof IsthmusGuardTripped>) => {
      tripped.push(event)
    }
    emitter.on(IsthmusGuardTripped, listener)

    try {
      const res = await client
        .get('/context-seal/mismatch')
        .header('x-tenant-id', tenantA.id)
        .header('x-other-tenant-id', tenantB.id)

      res.assertStatus(500)

      // The event is dispatched fire-and-forget; give the microtask queue a beat.
      await new Promise<void>((resolve) => setImmediate(resolve))
      const mismatches = tripped.filter((e) => e.payload.event === 'isthmus:seal:tenant:mismatch')
      assert.isAtLeast(mismatches.length, 1, 'the mismatch must be observable')
      assert.equal(mismatches[0].payload.severity, 'critical')
      assert.equal(mismatches[0].payload.tenantId, tenantB.id)
      assert.equal(mismatches[0].payload.metadata.requestResolvedId, tenantA.id)
    } finally {
      emitter.off(IsthmusGuardTripped, listener)
    }
  })

  test('the normal guarded path (scope agrees with the request) is unchanged', async ({
    client,
  }) => {
    const res = await client.get('/context-seal/query').header('x-tenant-id', tenantA.id)
    res.assertStatus(200)
    res.assertBodyContains({ tenantId: tenantA.id })
  })

  test('the job path (tenancy.run, no HttpContext) is inert', async ({ assert }) => {
    const Post = (await import('../../../fixtures/app/models/post.js')).default
    const tenant = await findTenant(tenantA.id)
    const posts = await tenancy.run(tenant, () => Post.all())
    assert.isArray(posts)
  })
})
