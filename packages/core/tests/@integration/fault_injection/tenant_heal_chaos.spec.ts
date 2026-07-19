import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { healTenant, getActiveDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { createTestTenant, destroyTestTenant } from '../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Fault-injection tier for the keystone remediation primitive. The resilience tier
 * (`resilience_tenant_heal_real.spec.ts`) proves heal's guarantees on the happy path —
 * provision-if-missing, migrate-to-head, idempotent re-run, TOCTOU-refuse a deleted
 * tenant, failed→active. This tier injects failures into the migrate step to pin down
 * how heal reacts to the two failure classes that behave OPPOSITELY:
 *
 *  1. A genuine migration failure must quarantine the tenant to `failed` with a STATUS
 *     WRITE ONLY — the schema heal already provisioned must survive (heal never drops
 *     on failure) — and a later heal must carry the same tenant the rest of the way to
 *     a fully-migrated `active`. A failed cure never leaves a tenant worse off.
 *
 *  2. Benign migration-lock contention must NOT quarantine. Lucid guards every
 *     migration with a single GLOBAL, non-blocking Postgres advisory lock
 *     (`PG_TRY_ADVISORY_LOCK('1')`), so ANY two overlapping tenant migrations contend
 *     and the loser fails fast with `E_UNABLE_ACQUIRE_LOCK`. That lock is exactly what
 *     keeps the ledger uncorrupted; the tenant is fine. Heal must rethrow it WITHOUT
 *     flipping a healthy tenant to `failed` (the regression a fleet heal at
 *     concurrency > 1, or a heal overlapping InstallTenant, would otherwise trigger),
 *     and a subsequent heal must still converge to a migrated `active`.
 */
const central = () => db.connection(getConfig().centralConnectionName)

async function schemaExists(schema: string): Promise<boolean> {
  const rows = await central().rawQuery(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`,
    [schema]
  )
  return (rows.rows ?? rows ?? []).length > 0
}
async function tableExists(schema: string, table: string): Promise<boolean> {
  const rows = await central().rawQuery(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
    [schema, table]
  )
  return (rows.rows ?? rows ?? []).length > 0
}
/** Migration names recorded more than once in the tenant's ledger — corruption. */
async function duplicateLedgerRows(schema: string): Promise<string[]> {
  const rows = await central().rawQuery(
    `SELECT name FROM "${schema}".adonis_schema GROUP BY name HAVING count(*) > 1`,
    []
  )
  return (rows.rows ?? []).map((r: { name: string }) => r.name)
}
async function tenantStatus(id: string): Promise<string> {
  const row = await db.connection('backoffice').query().from('tenants').where('id', id).first()
  return row.status
}
/** A stand-in for Lucid's global migration lock loser, matched by code in the healer. */
function acquireLockError(): Error {
  const e = new Error('Unable to acquire lock. Concurrent migrations are not allowed')
  ;(e as { code?: string }).code = 'E_UNABLE_ACQUIRE_LOCK'
  return e
}

/**
 * A stand-in for a Postgres duplicate-object collision (SQLSTATE 42P07,
 * duplicate_table), matched by SQLSTATE in the healer. This is what a relocated or
 * inlined migration surfaces when its `CREATE TABLE` hits an object already present.
 */
function duplicateTableError(table: string): Error {
  const e = new Error(`relation "${table}" already exists`)
  ;(e as { code?: string }).code = '42P07'
  return e
}

test.group('healTenant under injected migrate faults (fault injection, real Postgres)', () => {
  test('a genuine fault mid-migrate quarantines to failed without dropping the schema, then a later heal recovers it', async ({
    assert,
  }) => {
    const cfg = getConfig()
    const tenant = await createTestTenant({ status: 'active', name: 'FaultHeal' })
    const schema = `${cfg.tenantSchemaPrefix}${tenant.id}`
    const handle = { id: tenant.id } as TenantModelContract

    // Inject on the SAME driver instance heal resolves. The first migrate throws
    // (after heal has provisioned the schema); later calls delegate to the real one.
    const driver = await getActiveDriver()
    const origMigrate = (driver as any).migrate.bind(driver)
    let migrateCalls = 0
    ;(driver as any).migrate = async (...a: any[]) => {
      migrateCalls++
      if (migrateCalls === 1) throw new Error('injected: migrate failed mid-flight')
      return origMigrate(...a)
    }

    try {
      await assert.rejects(
        () => healTenant(handle, { fireHooks: false, audit: false }),
        /injected: migrate failed mid-flight/
      )

      // Quarantined — a status write ONLY. The schema heal created is still there:
      // heal never drops or resets on failure, so no data (had there been any) is lost.
      assert.equal(await tenantStatus(tenant.id), 'failed', 'the tenant is quarantined to failed')
      assert.isTrue(
        await schemaExists(schema),
        'the provisioned schema survives the failure — heal is non-destructive even when it fails'
      )
      assert.isFalse(
        await tableExists(schema, 'notes'),
        'the migration did not apply (the fault fired before it ran)'
      )

      // Second heal (fault cleared): carries the same tenant the rest of the way.
      const recovery = await healTenant(handle, { fireHooks: false, audit: false })
      assert.isFalse(recovery.provisioned, 'recovery reuses the surviving schema, provisions nothing')
      assert.isAbove(recovery.migrated, 0, 'recovery applies the migration that the fault blocked')
      assert.isTrue(await tableExists(schema, 'notes'), 'the per-tenant migration is now applied')
      assert.isEmpty(await duplicateLedgerRows(schema), 'the recovered ledger has no duplicate rows')
      assert.equal(
        await tenantStatus(tenant.id),
        'active',
        'a failed tenant returns to active once its storage is healthy'
      )
    } finally {
      ;(driver as any).migrate = origMigrate
      await central().rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await destroyTestTenant(tenant.id).catch(() => {})
    }
  })

  test('benign migration-lock contention is not mistaken for a tenant failure — heal rethrows without quarantining, and a retry converges', async ({
    assert,
  }) => {
    const cfg = getConfig()
    const tenant = await createTestTenant({ status: 'active', name: 'LockHeal' })
    const schema = `${cfg.tenantSchemaPrefix}${tenant.id}`
    const handle = { id: tenant.id } as TenantModelContract

    // First migrate loses the global advisory lock (another migration holds it);
    // later calls succeed, standing in for the concurrent migration having finished.
    const driver = await getActiveDriver()
    const origMigrate = (driver as any).migrate.bind(driver)
    let migrateCalls = 0
    ;(driver as any).migrate = async (...a: any[]) => {
      migrateCalls++
      if (migrateCalls === 1) throw acquireLockError()
      return origMigrate(...a)
    }

    try {
      // Heal provisions, then loses the lock. It must surface the contention…
      await assert.rejects(
        () => healTenant(handle, { fireHooks: false, audit: false }),
        /Concurrent migrations are not allowed/
      )

      // …but must NOT quarantine: the tenant stays active. This is the regression the
      // healer guards against — a benign lock race never degrades a healthy tenant.
      assert.equal(
        await tenantStatus(tenant.id),
        'active',
        'lock contention leaves the tenant active, never quarantined to failed'
      )
      assert.isTrue(await schemaExists(schema), 'the schema was provisioned before the lock loss')

      // Retry (the lock is now free): heal converges to a migrated, active tenant.
      const retry = await healTenant(handle, { fireHooks: false, audit: false })
      assert.isFalse(retry.provisioned, 'the retry reuses the schema from the first attempt')
      assert.isAbove(retry.migrated, 0, 'the retry applies the migration the contention blocked')
      assert.isTrue(await tableExists(schema, 'notes'), 'the per-tenant migration is applied on retry')
      assert.isEmpty(await duplicateLedgerRows(schema), 'the converged ledger has no duplicate rows')
      assert.equal(await tenantStatus(tenant.id), 'active', 'the tenant remains active after convergence')
    } finally {
      ;(driver as any).migrate = origMigrate
      await central().rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await destroyTestTenant(tenant.id).catch(() => {})
    }
  })

  test('a duplicate-object collision during migrate is benign — heal surfaces it, does NOT quarantine, and leaves the tenant in its prior state (the B0 Layer-1 universal net)', async ({
    assert,
  }) => {
    const cfg = getConfig()
    const tenant = await createTestTenant({ status: 'active', name: 'CollisionHeal' })
    const schema = `${cfg.tenantSchemaPrefix}${tenant.id}`
    const handle = { id: tenant.id } as TenantModelContract

    // First migrate collides with an object that already exists (a relocated/inlined
    // migration's CREATE TABLE), standing in for the Acme/carivo/Sahara relocation
    // state; later calls succeed (the collision cleared / reconciled).
    const driver = await getActiveDriver()
    const origMigrate = (driver as any).migrate.bind(driver)
    let migrateCalls = 0
    ;(driver as any).migrate = async (...a: any[]) => {
      migrateCalls++
      if (migrateCalls === 1) throw duplicateTableError('ai_embeddings')
      return origMigrate(...a)
    }

    try {
      // Heal provisions the schema, then the migration collides. It must NOT throw and
      // must NOT quarantine — the object already exists, so the tenant is not broken.
      const result = await healTenant(handle, { fireHooks: false, audit: false })
      assert.isNotEmpty(result.collisions, 'the collision is surfaced on the heal result')
      assert.include(
        result.collisions.join(','),
        'ai_embeddings',
        'the colliding object is named in the result'
      )
      assert.equal(
        await tenantStatus(tenant.id),
        'active',
        'a relocated-but-healthy tenant is NEVER quarantined to failed on a collision'
      )
      assert.isTrue(
        await schemaExists(schema),
        'the schema provisioned before the collision survives — heal is non-destructive'
      )

      // Retry with the collision cleared: heal converges normally, no collision.
      const retry = await healTenant(handle, { fireHooks: false, audit: false })
      assert.isEmpty(retry.collisions, 'the retry has no collision once the object is reconciled')
      assert.isTrue(await tableExists(schema, 'notes'), 'the per-tenant migration applies on retry')
      assert.isEmpty(await duplicateLedgerRows(schema), 'the converged ledger has no duplicate rows')
      assert.equal(await tenantStatus(tenant.id), 'active', 'the tenant remains active throughout')
    } finally {
      ;(driver as any).migrate = origMigrate
      await central().rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await destroyTestTenant(tenant.id).catch(() => {})
    }
  })
})
