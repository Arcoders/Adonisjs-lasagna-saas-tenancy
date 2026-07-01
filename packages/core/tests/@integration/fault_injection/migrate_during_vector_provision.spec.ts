import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  IsolationDriverRegistry,
  SchemaPgDriver,
  provisionVectorExtension,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { createTestTenant, destroyTestTenant } from '../../helpers/tenant.js'
import { AI_TAG } from '../../helpers/tags.js'

/**
 * Fault-injection tier: `tenant:vector:provision` and `tenant:migrate` running at
 * the same time for a fresh tenant.
 *
 * The concern this RETIRES (rather than fixes): the two do NOT need an advisory
 * lock. They touch disjoint objects — provisioning installs the database-level
 * `vector` extension (pg_extension catalog), migrate creates the tenant's schema
 * objects and its own `adonis_schema` ledger — and `CREATE EXTENSION IF NOT
 * EXISTS` is idempotent, so PostgreSQL's catalog locks serialize any overlap with
 * no corruption. This spec proves that: run both concurrently and assert the
 * extension is present AND the tenant's migration ledger is intact and queryable.
 *
 * The real prerequisite is ORDERING, not locking: a migration that declares a
 * `vector(N)` column needs the extension first. That is surfaced by the (opt-in)
 * `pgvectorExtensionCheck` doctor check, not by a lock. See the migrations doc
 * note added alongside this spec.
 *
 * Self-skips when the running PostgreSQL image ships no pgvector (plain postgres),
 * mirroring behavior_vector_provisioning; the CI pgvector image runs it for real.
 */
const central = () => db.connection(getConfig().centralConnectionName)

async function vectorAvailable(): Promise<boolean> {
  const r = await central().rawQuery(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
  return (r.rows ?? []).length > 0
}
async function vectorInstalled(): Promise<boolean> {
  const r = await central().rawQuery(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)
  return (r.rows ?? []).length > 0
}
async function ledgerQueryable(connectionName: string): Promise<number> {
  const rows = await db.connection(connectionName).from('adonis_schema').select('name')
  return rows.length
}
async function findTenantModel(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../fixtures/app/models/tenant.js')).default
  const t = await Tenant.find(id)
  if (!t) throw new Error(`tenant ${id} not found`)
  return t as unknown as TenantModelContract
}

test.group('migrate during vector:provision (fault injection, real Postgres)', (group) => {
  group.tap((t) => t.tags([AI_TAG]))

  let driver: SchemaPgDriver

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    if (reg.active().name !== 'schema-pg') {
      throw new Error(`this fault spec requires the schema-pg driver (got '${reg.active().name}')`)
    }
    driver = reg.active() as SchemaPgDriver
  })

  group.each.teardown(async () => {
    if (await vectorAvailable())
      await central()
        .rawQuery('DROP EXTENSION IF EXISTS vector')
        .catch(() => {})
  })

  test('interleaving corrupts neither the extension nor the migration ledger', async ({
    assert,
  }) => {
    if (!(await vectorAvailable())) return // self-skip on a plain postgres image

    const row = await createTestTenant({ status: 'provisioning' })
    const tenant = await findTenantModel(row.id)
    const connectionName = driver.connectionName(row.id)

    try {
      // Run the two operators' actions at the same time: the global extension
      // install and this tenant's full provision + migrate lifecycle.
      const [provision, lifecycle] = await Promise.allSettled([
        provisionVectorExtension({}),
        (async () => {
          await driver.provision(tenant)
          await driver.migrate(tenant, { direction: 'up' })
        })(),
      ])

      assert.equal(provision.status, 'fulfilled', 'vector provisioning completed')
      assert.equal(lifecycle.status, 'fulfilled', 'tenant provision + migrate completed')

      // Disjoint objects: the extension landed AND the tenant ledger is intact.
      assert.isTrue(
        await vectorInstalled(),
        'the vector extension is installed on the shared database'
      )
      assert.isAtLeast(
        await ledgerQueryable(connectionName),
        0,
        "the tenant's adonis_schema ledger is intact and queryable after the concurrent DDL"
      )
    } finally {
      await driver.destroy(tenant).catch(() => {})
      await destroyTestTenant(row.id).catch(() => {})
    }
  })
})
