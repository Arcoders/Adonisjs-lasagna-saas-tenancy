import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  CloneService,
  IsolationDriverRegistry,
  SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

async function findTenant(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../fixtures/app/models/tenant.js')).default
  const t = await Tenant.find(id)
  if (!t) throw new Error(`tenant ${id} not found`)
  return t as unknown as TenantModelContract
}

/**
 * End-to-end coverage for `CloneService.clone()` against real Postgres.
 *
 * The unit suite covers query-shape helpers; this spec exercises the
 * full clone lifecycle (provision destination → migrate → copy rows →
 * reset sequences → flip status) against a fixture migration that
 * creates a `notes` table. Verifies:
 *
 *   1. Full clone (schemaOnly:false) — both schemas, same row count,
 *      sequences reset on the destination so the next insert doesn't
 *      collide with copied ids.
 *   2. Schema-only clone (schemaOnly:true) — destination has the
 *      same DDL but is empty.
 *   3. Cleanup on failure — when the underlying provision fails, the
 *      destination flips to `failed` and the orphan schema is dropped.
 *
 * Uses the `tenant` template connection's `migrations.paths` (added
 * to `tests/fixtures/config/database.ts`) so `driver.migrate()` has
 * a real DDL set to apply on the destination schema.
 */
test.group('CloneService — full lifecycle E2E', (group) => {
  let driver: SchemaPgDriver
  const cleanup: string[] = []

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(`requires schema-pg driver (got '${active.name}')`)
    }
    driver = active as SchemaPgDriver
  })

  group.each.teardown(async () => {
    while (cleanup.length) {
      const id = cleanup.pop()!
      await driver.destroy({ id } as any).catch(() => {})
      await destroyTestTenant(id).catch(() => {})
    }
  })

  async function freshTenant(name?: string): Promise<TenantModelContract> {
    const t = await createTestTenant({ status: 'provisioning', name })
    cleanup.push(t.id)
    return findTenant(t.id)
  }

  test('full clone: destination ends up with same row count + reset sequence', async ({
    assert,
  }) => {
    const source = await freshTenant('Source-Full')
    await driver.provision(source)
    await driver.migrate(source, { direction: 'up' })

    // Seed three rows in the source schema. `id` is serial, so the
    // sequence advances to 3 — the spec then asserts the destination's
    // sequence is also reset to 3 (next insert would yield 4).
    const sourceConn = db.connection(`tenant_${source.id}`)
    await sourceConn.table('notes').insert([
      { title: 'one', body: 'first' },
      { title: 'two', body: 'second' },
      { title: 'three', body: 'third' },
    ])

    // `destination` row pre-exists with `status: provisioning`; the
    // service flips it to `active` once the clone succeeds.
    const destination = await freshTenant('Dest-Full')

    const svc = new CloneService()
    const result = await svc.clone(source, destination, {
      schemaOnly: false,
      clearSessions: false,
    })

    assert.equal(result.tablesCopied, 1, 'one user table copied (adonis_schema excluded)')
    assert.equal(result.rowsCopied, 3)
    assert.equal((destination as any).status, 'active', 'destination must flip to active')

    // CloneService.clone() releases the destination's connection at the
    // end (so the next consumer opens a fresh session against the
    // post-migration schema). Re-register it before doing direct DB
    // truth-checks — that's what a production caller would do via
    // `request.tenant()` on the next request.
    await driver.connect(destination)
    const destConn = db.connection(`tenant_${destination.id}`)
    const rows = await destConn.from('notes').select('id', 'title').orderBy('id')
    assert.lengthOf(rows, 3)
    assert.deepEqual(
      rows.map((r) => r.title),
      ['one', 'two', 'three']
    )

    // Sequence reset: the next insert must NOT reuse an existing id.
    const [inserted] = await destConn
      .table('notes')
      .insert({ title: 'four', body: 'after-clone' })
      .returning('id')
    assert.equal(
      inserted.id,
      4,
      'destination sequence must be reset to MAX(id) so the next insert continues the series'
    )
  })

  test('schema-only clone: destination has the table but zero rows', async ({ assert }) => {
    const source = await freshTenant('Source-SchemaOnly')
    await driver.provision(source)
    await driver.migrate(source, { direction: 'up' })
    await db
      .connection(`tenant_${source.id}`)
      .table('notes')
      .insert({ title: 'present-in-source' })

    const destination = await freshTenant('Dest-SchemaOnly')

    const svc = new CloneService()
    const result = await svc.clone(source, destination, {
      schemaOnly: true,
      clearSessions: false,
    })

    assert.equal(result.tablesCopied, 0, 'schemaOnly must skip the copy phase')
    assert.equal(result.rowsCopied, 0)
    assert.equal((destination as any).status, 'active')

    // The destination schema must have the `notes` table (migrations
    // ran) but it must be empty. Re-register the connection since
    // CloneService disconnects it at the end of clone().
    await driver.connect(destination)
    const destConn = db.connection(`tenant_${destination.id}`)
    const rows = await destConn.from('notes').select('id')
    assert.lengthOf(rows, 0, 'schemaOnly: destination must be empty')
  })

  test('cleanup-on-failure: destination flips to failed AND schema is dropped', async ({
    assert,
  }) => {
    // Force a failure by passing a destination model whose schema
    // already exists with conflicting state — provision() will throw
    // when migrate tries to create `notes` against a half-populated
    // schema we owned beforehand.
    const source = await freshTenant('Source-Fail')
    await driver.provision(source)
    await driver.migrate(source, { direction: 'up' })

    const destination = await freshTenant('Dest-Fail')
    // Pre-create the destination's schema with a `notes` table whose
    // shape conflicts with the migration — migrate will fail.
    const schema = `tenant_${destination.id}`
    const central = db.connection('public')
    await central.rawQuery(`CREATE SCHEMA "${schema}"`)
    await central.rawQuery(
      `CREATE TABLE "${schema}".notes (id text PRIMARY KEY)` // wrong shape; migration's CREATE will fail
    )

    const svc = new CloneService()
    let caught: any = null
    try {
      await svc.clone(source, destination, { schemaOnly: false, clearSessions: false })
    } catch (err) {
      caught = err
    }
    assert.isNotNull(caught, 'clone must throw when migration fails on the destination')

    // The destination row must be marked failed AND its schema
    // must be dropped — `clone()` does best-effort teardown.
    const Tenant = (await import('../../fixtures/app/models/tenant.js')).default
    const refreshed = (await Tenant.find(destination.id)) as any
    assert.equal(refreshed?.status, 'failed')

    const schemaExists = await central.rawQuery(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`,
      [schema]
    )
    assert.lengthOf(
      schemaExists.rows ?? schemaExists,
      0,
      'orphan destination schema must be dropped after a failed clone'
    )
  })
})
