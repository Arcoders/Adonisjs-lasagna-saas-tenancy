import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * WS-1 / adapter-assumes-connection-preregistered (integration).
 *
 * tenancy.run() is the canonical non-HTTP context entry point. Before the fix
 * it bound AsyncLocalStorage + bootstrappers but never called
 * driver.connect(), so the FIRST TenantBaseModel query inside the scope routed
 * to a connection the adapter never registered. In a cold worker process (or
 * after an LRU eviction) that surfaced as an opaque Lucid
 * "connection is not registered" error.
 *
 * RED (pre-fix): after driver.disconnect(model), `tenancy.run(model, () =>
 * Post.all())` rejects with the raw Lucid error.
 * GREEN (post-fix): tenancy.run() awaits driver.connect() before entering the
 * scope, so the model query resolves and db.manager.has(name) is true inside.
 */
test.group('tenancy.run() connects the tenant before a model query routes to it', (group) => {
  let driver: SchemaPgDriver
  let tenantId: string
  let model: TenantModelContract

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
      throw new Error(`requires schema-pg driver (got '${active.name}')`)
    }
    driver = active as SchemaPgDriver

    const t = await createTestTenant({ status: 'active' })
    tenantId = t.id
    model = await findTenant(t.id)
    await driver.provision(model)
    await db.connection(`tenant_${tenantId}`).rawQuery(`
      CREATE TABLE posts (
        id    serial PRIMARY KEY,
        title text NOT NULL
      )
    `)
  })

  group.teardown(async () => {
    await driver.destroy({ id: tenantId } as any).catch(() => {})
    await destroyTestTenant(tenantId).catch(() => {})
  })

  test('a cold tenant (connection not registered) is connected by tenancy.run before the query', async ({
    assert,
  }) => {
    const Post = (await import('../../fixtures/app/models/post.js')).default
    const name = `tenant_${tenantId}`

    // Simulate a cold worker / post-eviction state: drop the registered
    // connection so db.manager.has(name) === false going into the run.
    await driver.disconnect(model)
    assert.isFalse(db.manager.has(name), 'precondition: connection is not registered')

    // On the FIXED code this resolves (run() connects first); on the buggy
    // code it rejects with the opaque Lucid "not registered" error.
    let registeredInside = false
    const rows = await tenancy.run(model, async () => {
      registeredInside = db.manager.has(name)
      return Post.all()
    })

    assert.isTrue(registeredInside, 'tenancy.run must register the connection before the query')
    assert.isArray(rows)
  })
})
