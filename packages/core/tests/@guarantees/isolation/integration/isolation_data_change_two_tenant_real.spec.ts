import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import emitter from '@adonisjs/core/services/emitter'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { TenantDataChanged } from '@adonisjs-lasagna/saas-tenancy/mixins'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * ISOLATION — cross-tenant data-change attribution against REAL Postgres. The
 * sibling resilience spec proves after-commit vs rollback for a SINGLE tenant; the
 * unit spec proves attribution against fakes. Neither proves the cross-tenant
 * NEGATIVE: that a change committed inside tenant B is delivered tagged with B (never
 * A), so a subscriber that scopes to its own tenant NEVER acts on another tenant's
 * change. This drives two real provisioned tenants and a real emitter subscriber and
 * asserts the change carries the ORIGINATING tenant's id — the property the W0
 * `onDataChange`/`tenancy.run` scope fix depends on.
 */
test.group('data-change cross-tenant attribution (real Postgres)', (group) => {
  let driver: SchemaPgDriver
  let tenantA: TenantModelContract
  let tenantB: TenantModelContract
  let TrackedNote: typeof import('../../../fixtures/app/models/tracked_note.js').default

  const settle = () => new Promise((r) => setTimeout(r, 25))

  async function provisionWithNotes(status: 'active'): Promise<TenantModelContract> {
    const t = await createTestTenant({ status })
    const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
    const tenant = (await Tenant.findOrFail(t.id)) as unknown as TenantModelContract
    await driver.provision(tenant)
    await db
      .connection(`tenant_${tenant.id}`)
      .rawQuery(
        `CREATE TABLE IF NOT EXISTS tracked_notes (id serial PRIMARY KEY, body text NOT NULL)`
      )
    return tenant
  }

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(`data-change integration requires schema-pg (got '${active.name}')`)
    }
    driver = active as SchemaPgDriver
    tenantA = await provisionWithNotes('active')
    tenantB = await provisionWithNotes('active')
    TrackedNote = (await import('../../../fixtures/app/models/tracked_note.js')).default
  })

  group.teardown(async () => {
    await destroyTestTenant(tenantA.id).catch(() => {})
    await destroyTestTenant(tenantB.id).catch(() => {})
  })

  group.each.teardown(() => emitter.restore())

  test('a change committed in tenant B is delivered tagged B — an A-scoped subscriber sees nothing', async ({
    assert,
  }) => {
    // A REAL subscriber that records the originating tenant of every change (the same
    // event `definePlugin({ onDataChange })` wires).
    const received: Array<{ tenantId: string; body?: string }> = []
    const off = emitter.on(TenantDataChanged, (e: any) =>
      received.push({ tenantId: e.change.tenantId })
    )

    try {
      // Interleave one committed write per tenant.
      await tenancy.run(tenantA, async () => {
        await TrackedNote.create({ body: 'for-A' })
      })
      await tenancy.run(tenantB, async () => {
        await TrackedNote.create({ body: 'for-B' })
      })
      await settle()

      // Exactly one change per tenant, each attributed to its ORIGINATING tenant.
      assert.lengthOf(received, 2)
      const forA = received.filter((r) => r.tenantId === tenantA.id)
      const forB = received.filter((r) => r.tenantId === tenantB.id)
      assert.lengthOf(forA, 1, 'tenant A’s write is attributed to A')
      assert.lengthOf(forB, 1, 'tenant B’s write is attributed to B')

      // The cross-tenant NEGATIVE: a subscriber scoped to A (filtering tenantId === A)
      // never receives B’s change, so it can never act on another tenant’s data.
      const aScoped = received.filter((r) => r.tenantId === tenantA.id)
      assert.isFalse(
        aScoped.some((r) => r.tenantId === tenantB.id),
        'an A-scoped consumer must not receive tenant B’s change'
      )
    } finally {
      off()
    }
  })
})
