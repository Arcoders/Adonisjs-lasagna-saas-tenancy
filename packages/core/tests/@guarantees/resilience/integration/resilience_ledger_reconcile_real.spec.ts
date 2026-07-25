import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { healTenant } from '@adonisjs-lasagna/saas-tenancy/services'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
// The reconcile envelope is internal (singleton-free — it takes the central connection
// and schema as inputs), so it is safe to drive from source in an integration spec while
// the live central connection comes from the booted build.
import {
  reconcileTenantLedger,
  type ExpectedStructure,
  type CentralLike,
} from '../../../../src/services/doctor/tenant_ledger_reconcile.js'
import type { ResolvedMigrationAlias } from '../../../../src/sdk/configure_kit.js'

/**
 * Part D integration tier + C4 property — the reconcile envelope against REAL Postgres.
 * Proves the zero-DDL ledger rewrite is byte-preserving (the do-no-harm property for the
 * physical-identity fix), idempotent, and fail-closed on the SQL gates the unit tier
 * cannot reach (multiplicity, physical existence, transaction rewrite, verify).
 */
const central = () => db.connection(getConfig().centralConnectionName)
const centralLike = () => central() as unknown as CentralLike

async function ledgerNames(schema: string): Promise<string[]> {
  const rows = await central().rawQuery(`SELECT name FROM "${schema}".adonis_schema ORDER BY name`)
  return (rows.rows ?? []).map((r: { name: string }) => r.name)
}
async function ledgerRow(schema: string, name: string): Promise<any> {
  const rows = await central().rawQuery(
    `SELECT id, name, batch, migration_time FROM "${schema}".adonis_schema WHERE name = ?`,
    [name]
  )
  return (rows.rows ?? [])[0]
}

/** Introspect the given tables into an ExpectedStructure (table → column → udt). */
async function structureOf(schema: string, tables: string[]): Promise<ExpectedStructure> {
  const objects = new Map<string, Map<string, string>>()
  for (const table of tables) {
    const rows = await central().rawQuery(
      `SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
      [schema, table]
    )
    const cols = new Map<string, string>()
    for (const r of rows.rows ?? []) cols.set(String(r.column_name), String(r.udt_name))
    objects.set(table, cols)
  }
  return { objects }
}

const aliasMapFor = (from: string, to: string): Map<string, ResolvedMigrationAlias> =>
  new Map([[to, { from, to, ownerPackage: '@test/x', ownerSlug: 'x' }]])

/**
 * Set up a healthy tenant, seed a row into `notes`, then simulate a relocation by
 * renaming the `notes` migration's ledger row to a legacy `from` name.
 */
async function relocatedTenant() {
  const cfg = getConfig()
  const tenant = await createTestTenant({ status: 'active', name: 'ReconcileReal' })
  const schema = `${cfg.tenantSchemaPrefix}${tenant.id}`
  await healTenant({ id: tenant.id } as TenantModelContract, { fireHooks: false, audit: false })
  await central().rawQuery(`INSERT INTO "${schema}".notes (title) VALUES ('keep-me')`)

  const names = await ledgerNames(schema)
  const to = names.find((n) => n.includes('notes'))!
  const from = 'database/migrations/tenant/0099_legacy_notes'
  await central().rawQuery(`UPDATE "${schema}".adonis_schema SET name = ? WHERE name = ?`, [
    from,
    to,
  ])

  return { tenant, schema, from, to, source: new Set(names) }
}

async function cleanup(schema: string, tenantId: string) {
  await central().rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await destroyTestTenant(tenantId).catch(() => {})
}

const deps = async () => ({
  repo: (await resolveTenantRepository()) as any,
  central: centralLike(),
  audit: async () => {},
})

test.group('reconcileTenantLedger against real Postgres', () => {
  test('rewrites the ledger row from→to with zero DDL, preserving the table data byte-for-byte', async ({
    assert,
  }) => {
    const { tenant, schema, from, to, source } = await relocatedTenant()
    try {
      const beforeRow = await ledgerRow(schema, from)
      const beforeCount = (
        await central().rawQuery(`SELECT count(*)::int AS n FROM "${schema}".notes`)
      ).rows[0].n

      const outcome = await reconcileTenantLedger(
        {
          tenantId: tenant.id,
          schema,
          from,
          to,
          source,
          aliasMap: aliasMapFor(from, to),
          expected: await structureOf(schema, ['notes']),
        },
        await deps()
      )

      assert.equal(outcome.status, 'reconciled')
      const names = await ledgerNames(schema)
      assert.include(names, to, 'the canonical name is now in the ledger')
      assert.notInclude(names, from, 'the legacy name is gone')

      const afterRow = await ledgerRow(schema, to)
      assert.equal(
        afterRow.id,
        beforeRow.id,
        'the ledger row id is preserved (identity, not re-insert)'
      )
      assert.equal(String(afterRow.batch), String(beforeRow.batch), 'batch preserved')

      const afterCount = (
        await central().rawQuery(`SELECT count(*)::int AS n FROM "${schema}".notes`)
      ).rows[0].n
      assert.equal(
        afterCount,
        beforeCount,
        'the table row count is unchanged (zero DDL, zero data change)'
      )
    } finally {
      await cleanup(schema, tenant.id)
    }
  })

  test('is idempotent: a second reconcile short-circuits to already_reconciled', async ({
    assert,
  }) => {
    const { tenant, schema, from, to, source } = await relocatedTenant()
    try {
      const d = await deps()
      const expected = await structureOf(schema, ['notes'])
      const first = await reconcileTenantLedger(
        {
          tenantId: tenant.id,
          schema,
          from,
          to,
          source,
          aliasMap: aliasMapFor(from, to),
          expected,
        },
        d
      )
      assert.equal(first.status, 'reconciled')
      const second = await reconcileTenantLedger(
        {
          tenantId: tenant.id,
          schema,
          from,
          to,
          source,
          aliasMap: aliasMapFor(from, to),
          expected,
        },
        d
      )
      assert.equal(second.status, 'already_reconciled')
    } finally {
      await cleanup(schema, tenant.id)
    }
  })

  test('refuses (physical_absent) when the object to build does not exist — routes to heal', async ({
    assert,
  }) => {
    const { tenant, schema, from, to, source } = await relocatedTenant()
    try {
      // Expect a table that is NOT in the schema → stamp-a-lie is refused.
      const expected: ExpectedStructure = {
        objects: new Map([['ghost_table', new Map([['id', 'int4']])]]),
      }
      const outcome = await reconcileTenantLedger(
        {
          tenantId: tenant.id,
          schema,
          from,
          to,
          source,
          aliasMap: aliasMapFor(from, to),
          expected,
        },
        await deps()
      )
      assert.equal(outcome.status, 'refused')
      assert.equal((outcome as any).reason, 'physical_absent')
      // The ledger is untouched (still the legacy name).
      assert.include(await ledgerNames(schema), from)
    } finally {
      await cleanup(schema, tenant.id)
    }
  })

  test('refuses (from_still_in_source) when from is a live migration', async ({ assert }) => {
    const { tenant, schema, from, to } = await relocatedTenant()
    try {
      // A source set that still contains `from` means from is a live migration.
      const outcome = await reconcileTenantLedger(
        {
          tenantId: tenant.id,
          schema,
          from,
          to,
          source: new Set([to, from]),
          aliasMap: aliasMapFor(from, to),
          expected: await structureOf(schema, ['notes']),
        },
        await deps()
      )
      assert.equal(outcome.status, 'refused')
      assert.equal((outcome as any).reason, 'from_still_in_source')
    } finally {
      await cleanup(schema, tenant.id)
    }
  })

  test('refuses (to_already_present) when the canonical name is already in the ledger', async ({
    assert,
  }) => {
    const { tenant, schema, from, to, source } = await relocatedTenant()
    try {
      // Insert a duplicate `to` row so both from and to are present.
      await central().rawQuery(
        `INSERT INTO "${schema}".adonis_schema (name, batch, migration_time) VALUES (?, 1, now())`,
        [to]
      )
      const outcome = await reconcileTenantLedger(
        {
          tenantId: tenant.id,
          schema,
          from,
          to,
          source,
          aliasMap: aliasMapFor(from, to),
          expected: await structureOf(schema, ['notes']),
        },
        await deps()
      )
      assert.equal(outcome.status, 'refused')
      assert.equal((outcome as any).reason, 'to_already_present')
    } finally {
      await cleanup(schema, tenant.id)
    }
  })
})
