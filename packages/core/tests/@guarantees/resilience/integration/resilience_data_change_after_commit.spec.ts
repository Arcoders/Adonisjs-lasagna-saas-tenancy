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
 * A gating integration test for the data-change mixin's after-commit vs
 * rollback guarantee against REAL Postgres, the property the unit test can only
 * stub. A committed write EMITS `TenantDataChanged`; a rolled-back write emits
 * NOTHING. Runs on the schema-pg fixture, and the integration runner guarantees
 * Postgres, so there is no per-spec skip. Mirrors behavior_tenant_context's
 * tenant/schema setup.
 */
test.group('data-change mixin — after-commit vs rollback (real Postgres)', (group) => {
  let driver: SchemaPgDriver
  let tenant: TenantModelContract
  let TrackedNote: typeof import('../../../fixtures/app/models/tracked_note.js').default

  // Let a fire-and-forget after-commit emit settle before asserting on the buffer.
  const settle = () => new Promise((r) => setTimeout(r, 25))

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(`data-change integration requires schema-pg (got '${active.name}')`)
    }
    driver = active as SchemaPgDriver

    const t = await createTestTenant({ status: 'active' })
    const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
    tenant = (await Tenant.findOrFail(t.id)) as unknown as TenantModelContract
    await driver.provision(tenant)
    await db
      .connection(`tenant_${tenant.id}`)
      .rawQuery(
        `CREATE TABLE IF NOT EXISTS tracked_notes (id serial PRIMARY KEY, body text NOT NULL)`
      )
    TrackedNote = (await import('../../../fixtures/app/models/tracked_note.js')).default
  })

  group.teardown(async () => {
    await destroyTestTenant(tenant.id).catch(() => {})
  })

  group.each.teardown(() => emitter.restore())

  test('a committed create EMITS TenantDataChanged with a names-only payload', async ({
    assert,
  }) => {
    const buf = emitter.fake([TenantDataChanged])
    await tenancy.run(tenant, async () => {
      await TrackedNote.create({ body: 'hello' })
    })
    await settle()

    buf.assertEmitted(TenantDataChanged)
    const found = buf.find(TenantDataChanged) as any
    assert.equal(found.data.change.tenantId, tenant.id)
    assert.equal(found.data.change.model, 'TrackedNote')
    assert.equal(found.data.change.table, 'tracked_notes')
    assert.equal(found.data.change.operation, 'create')
    // names-only: the payload never carries the row's column values, but does carry
    // the primary key so a subscriber can re-read the row.
    assert.notProperty(found.data.change, 'values')
    assert.property(found.data.change.keys, 'id')
  })

  test('a ROLLED-BACK write emits NOTHING', async ({ assert }) => {
    const buf = emitter.fake([TenantDataChanged])
    await tenancy.run(tenant, async () => {
      await db
        .transaction(async (trx) => {
          const note = new TrackedNote()
          note.body = 'doomed'
          note.useTransaction(trx)
          await note.save()
          // Abort to force a ROLLBACK. The after-commit emit must never fire.
          throw new Error('intentional rollback')
        })
        .catch(() => {})
    })
    await settle()

    buf.assertNotEmitted(TenantDataChanged)
  })

  test('end-to-end: a real subscriber receives a committed change', async ({ assert }) => {
    // The usage proof: the mixin's REAL emit reaches a REAL subscriber (the same
    // path `definePlugin({ onDataChange })` wires) against live Postgres.
    const received: Array<{ model: string; operation: string; tenantId: string }> = []
    const off = emitter.on(TenantDataChanged, (e: any) => {
      received.push(e.change)
    })
    try {
      await tenancy.run(tenant, async () => {
        await TrackedNote.create({ body: 'observed' })
      })
      await settle()
      assert.lengthOf(received, 1)
      assert.equal(received[0]!.model, 'TrackedNote')
      assert.equal(received[0]!.operation, 'create')
      assert.equal(received[0]!.tenantId, tenant.id)
    } finally {
      off()
    }
  })

  test('an update carries the changed COLUMN NAMES', async ({ assert }) => {
    let id = 0
    await tenancy.run(tenant, async () => {
      const note = await TrackedNote.create({ body: 'v1' })
      id = note.id
    })
    const buf = emitter.fake([TenantDataChanged])
    await tenancy.run(tenant, async () => {
      const note = await TrackedNote.findOrFail(id)
      note.body = 'v2'
      await note.save()
    })
    await settle()

    buf.assertEmitted(TenantDataChanged)
    const found = buf.find(TenantDataChanged) as any
    assert.equal(found.data.change.operation, 'update')
    assert.deepEqual([...(found.data.change.columns ?? [])], ['body'])
  })
})
