import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '../../../integration/helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * WS-1 / searchpath-pinned-per-connection-name (integration).
 *
 * SchemaPgDriver.connect()'s cached-connection fast path returns a connection
 * registered under the tenant's name without checking that connection's
 * searchPath still points at this tenant's schema. A name collision / stale
 * registration / prefix change would then serve a connection scoped to a
 * DIFFERENT tenant's schema.
 *
 * RED (pre-fix): connect(A) over a connection registered under A's name but
 * carrying B's searchPath returns it silently. GREEN (post-fix): connect(A)
 * throws (E_ISOLATION_CONFIG, naming the searchPath) instead of serving a
 * possibly cross-tenant connection.
 */
test.group('SchemaPgDriver.connect() pins searchPath on the cached fast path', (group) => {
  let driver: SchemaPgDriver
  let a: TenantModelContract
  let b: TenantModelContract
  const ids: string[] = []

  async function findTenant(id: string): Promise<TenantModelContract> {
    const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
    const t = await Tenant.find(id)
    if (!t) throw new Error(`tenant ${id} not found`)
    return t as unknown as TenantModelContract
  }

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') throw new Error(`requires schema-pg (got '${active.name}')`)
    driver = active as SchemaPgDriver

    const ta = await createTestTenant({ status: 'active' })
    const tb = await createTestTenant({ status: 'active' })
    ids.push(ta.id, tb.id)
    a = await findTenant(ta.id)
    b = await findTenant(tb.id)
    await driver.provision(a)
    await driver.provision(b)
  })

  group.teardown(async () => {
    for (const id of ids) {
      await driver.destroy({ id } as any).catch(() => {})
      await destroyTestTenant(id).catch(() => {})
    }
  })

  test('connect(A) throws when the registered connection carries another tenant schema searchPath', async ({
    assert,
  }) => {
    const nameA = driver.connectionName(a.id)
    const schemaB = driver.schemaName(b)

    // Corrupt the manager: register tenant A's connection NAME with tenant B's
    // searchPath (models a prefix collision / stale registration).
    await driver.disconnect(a)
    const template = db.manager.get('tenant')?.config
    assert.isDefined(template, 'template connection must exist')
    db.manager.add(nameA, { ...(template as any), searchPath: [schemaB] } as any)

    let err: any
    try {
      await driver.connect(a)
    } catch (e) {
      err = e
    }

    assert.isDefined(err, 'connect(A) must refuse a connection pinned to another tenant schema')
    assert.equal(err.code, 'E_ISOLATION_CONFIG')
    assert.match(err.message, /searchPath/)
  })

  test('connect(A) succeeds after a correct re-provision (control)', async ({ assert }) => {
    await driver.disconnect(a).catch(() => {})
    await driver.connect(a)
    const client = db.connection(driver.connectionName(a.id))
    const res: any = await client.rawQuery('SHOW search_path')
    const shown = JSON.stringify(res?.rows ?? res)
    assert.match(shown, new RegExp(driver.schemaName(a)))
  })
})
