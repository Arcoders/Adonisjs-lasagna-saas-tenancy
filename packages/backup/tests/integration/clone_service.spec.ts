import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { CloneService } from '@adonisjs-lasagna/backup'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

async function findTenant(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../../core/tests/fixtures/app/models/tenant.js')).default
  const t = await Tenant.find(id)
  if (!t) throw new Error(`tenant ${id} not found`)
  return t as unknown as TenantModelContract
}

// Full CloneService.clone() lifecycle against real Postgres: full copy
// with sequence reset, schemaOnly copy, and cleanup-on-failure.
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

    // Seed 3 rows so the sequence advances to 3; assert below that the
    // destination's sequence resets accordingly (next insert = 4).
    const sourceConn = db.connection(`tenant_${source.id}`)
    await sourceConn.table('notes').insert([
      { title: 'one', body: 'first' },
      { title: 'two', body: 'second' },
      { title: 'three', body: 'third' },
    ])

    const destination = await freshTenant('Dest-Full')

    const svc = new CloneService()
    const result = await svc.clone(source, destination, {
      schemaOnly: false,
      clearSessions: false,
    })

    assert.equal(result.tablesCopied, 1, 'one user table copied (adonis_schema excluded)')
    assert.equal(result.rowsCopied, 3)
    assert.equal((destination as any).status, 'active', 'destination must flip to active')

    // clone() disconnects the destination — re-register here, same as
    // request.tenant() would on the next request.
    await driver.connect(destination)
    const destConn = db.connection(`tenant_${destination.id}`)
    const rows = await destConn.from('notes').select('id', 'title').orderBy('id')
    assert.lengthOf(rows, 3)
    assert.deepEqual(
      rows.map((r) => r.title),
      ['one', 'two', 'three']
    )

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
    await db.connection(`tenant_${source.id}`).table('notes').insert({ title: 'present-in-source' })

    const destination = await freshTenant('Dest-SchemaOnly')

    const svc = new CloneService()
    const result = await svc.clone(source, destination, {
      schemaOnly: true,
      clearSessions: false,
    })

    assert.equal(result.tablesCopied, 0, 'schemaOnly must skip the copy phase')
    assert.equal(result.rowsCopied, 0)
    assert.equal((destination as any).status, 'active')

    await driver.connect(destination)
    const destConn = db.connection(`tenant_${destination.id}`)
    const rows = await destConn.from('notes').select('id')
    assert.lengthOf(rows, 0, 'schemaOnly: destination must be empty')
  })

  test('cleanup-on-failure: destination flips to failed AND schema is dropped', async ({
    assert,
  }) => {
    const source = await freshTenant('Source-Fail')
    await driver.provision(source)
    await driver.migrate(source, { direction: 'up' })

    // Pre-create the destination's `notes` with a conflicting shape so
    // the migration fails.
    const destination = await freshTenant('Dest-Fail')
    const schema = `tenant_${destination.id}`
    const central = db.connection('public')
    await central.rawQuery(`CREATE SCHEMA "${schema}"`)
    await central.rawQuery(`CREATE TABLE "${schema}".notes (id text PRIMARY KEY)`)

    const svc = new CloneService()
    let caught: any = null
    try {
      await svc.clone(source, destination, { schemaOnly: false, clearSessions: false })
    } catch (err) {
      caught = err
    }
    assert.isNotNull(caught, 'clone must throw when migration fails on the destination')

    const Tenant = (await import('../../../core/tests/fixtures/app/models/tenant.js')).default
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
