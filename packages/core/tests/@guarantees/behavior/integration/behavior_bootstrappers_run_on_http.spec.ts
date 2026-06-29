import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import {
  IsolationDriverRegistry,
  BootstrapperRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * WS-1 / bootstrappers-skip-http-path (integration).
 *
 * The bootstrapper enter()/leave() lifecycle only ran via tenancy.run() (the
 * background/queue path). Both HTTP middlewares wrapped next() in a bare
 * logCtx.run(), so a host's custom bootstrapper silently no-opped on every
 * HTTP request while working in jobs. A bootstrapper that performs an
 * isolation-relevant action (e.g. setting an RLS GUC) would leave the HTTP
 * path unprotected.
 *
 * RED (pre-fix): the probe's enter array stays empty after a guarded /tenant
 * request (and after a /universal request). GREEN (post-fix): both middlewares
 * delegate to tenancy.runForRequest(), so enter fires before the handler with
 * the right tenant id and leave fires after.
 */
const events: { phase: 'enter' | 'leave'; tenantId: string }[] = []
const PROBE = 'ws1-http-bootstrapper-probe'
const probe = {
  name: PROBE,
  enter(ctx: { tenant: TenantModelContract }) {
    events.push({ phase: 'enter', tenantId: ctx.tenant.id })
  },
  leave(ctx: { tenant: TenantModelContract }) {
    events.push({ phase: 'leave', tenantId: ctx.tenant.id })
  },
}

test.group('bootstrapper enter/leave fire on the HTTP request path', (group) => {
  let driver: SchemaPgDriver
  let tenantId: string
  let hadProbe = false

  async function findTenant(id: string): Promise<TenantModelContract> {
    const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
    const t = await Tenant.find(id)
    if (!t) throw new Error(`tenant ${id} not found`)
    return t as unknown as TenantModelContract
  }

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    driver = reg.active() as SchemaPgDriver

    const t = await createTestTenant({ status: 'active' })
    tenantId = t.id
    await driver.provision(await findTenant(t.id))

    // Register the probe last: Japa skips group.teardown when group.setup throws,
    // so a probe registered before a failing createTestTenant/provision would leak
    // into the next spec.
    const registry = await app.container.make(BootstrapperRegistry)
    hadProbe = registry.has(PROBE)
    if (!hadProbe) registry.register(probe)
  })

  group.teardown(async () => {
    const registry = await app.container.make(BootstrapperRegistry)
    if (!hadProbe) registry.unregister(PROBE)
    await driver.destroy({ id: tenantId } as any).catch(() => {})
    await destroyTestTenant(tenantId).catch(() => {})
  })

  test('guarded route (/tenant/ping) runs the bootstrapper lifecycle', async ({
    client,
    assert,
  }) => {
    events.length = 0
    const res = await client.get('/tenant/ping').header('x-tenant-id', tenantId)
    res.assertStatus(200)

    const enters = events.filter((e) => e.phase === 'enter' && e.tenantId === tenantId)
    const leaves = events.filter((e) => e.phase === 'leave' && e.tenantId === tenantId)
    assert.isAtLeast(enters.length, 1, 'enter() must fire on a guarded HTTP request')
    assert.isAtLeast(leaves.length, 1, 'leave() must fire after the guarded HTTP request')
  })

  test('universal route (/universal/ping) runs the bootstrapper lifecycle', async ({
    client,
    assert,
  }) => {
    events.length = 0
    const res = await client.get('/universal/ping').header('x-tenant-id', tenantId)
    res.assertStatus(200)

    const enters = events.filter((e) => e.phase === 'enter' && e.tenantId === tenantId)
    const leaves = events.filter((e) => e.phase === 'leave' && e.tenantId === tenantId)
    assert.isAtLeast(
      enters.length,
      1,
      'enter() must fire on a universal HTTP request with a tenant'
    )
    assert.isAtLeast(leaves.length, 1, 'leave() must fire after a universal HTTP request')
  })
})
