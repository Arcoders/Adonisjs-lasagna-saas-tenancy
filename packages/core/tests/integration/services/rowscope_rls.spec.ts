import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { withTenantRls } from '@adonisjs-lasagna/saas-tenancy/services'
import { randomUUID } from 'node:crypto'

/**
 * Proves the RLS defense-in-depth layer for `rowscope-pg`: a query with NO
 * application-level scope and a top-level `orWhere` (the exact shape the
 * `withTenantScope` mixin cannot retroactively group) still returns only the
 * active tenant's rows, because the PostgreSQL policy enforces it.
 *
 * The PROOF runs on the `rls_probe` connection, which CI authenticates as a
 * NOSUPERUSER NOBYPASSRLS role (via RLS_DB_USER/RLS_DB_PASSWORD) so the policy
 * is actually enforced. DDL + seeding run on the privileged `public` connection.
 * Self-skips only when `rls_probe` resolves to a SUPERUSER/BYPASSRLS role (the
 * local default), since the proof would be meaningless there. The deterministic
 * coverage lives in tests/unit/services/rls.spec.ts.
 */
const TABLE = 'lasagna_rls_test_posts'
const POLICY = 'tenant_isolation'
// The connection the proof executes on — least-privilege in CI.
const PROBE_CONN = 'rls_probe'

let rlsEnforced = false
const tenantA = randomUUID()
const tenantB = randomUUID()

function rowsOf(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : ((result as any).rows ?? result)
}

test.group('rowscope RLS (integration)', (group) => {
  group.setup(async () => {
    const admin = db.connection('public') // privileged: DDL + seed + grants
    const probe = db.connection(PROBE_CONN) // the role the proof runs as

    // Does the PROBE role actually get RLS enforced? Superusers and BYPASSRLS
    // roles are exempt even with FORCE ROW LEVEL SECURITY. We must check the
    // role that EXECUTES the proof, not the privileged DDL role.
    const flagsRes = await probe.rawQuery(
      `select
         current_setting('is_superuser') = 'on' as super,
         coalesce((select rolbypassrls from pg_roles where rolname = current_user), false) as bypass`
    )
    const flags = rowsOf(flagsRes)[0]
    rlsEnforced = !(flags.super === true || flags.bypass === true)

    await admin.rawQuery(`DROP TABLE IF EXISTS ${TABLE}`)
    await admin.rawQuery(`
      CREATE TABLE ${TABLE} (
        id serial PRIMARY KEY,
        title text NOT NULL,
        tenant_id text NOT NULL
      )
    `)

    // Seed BOTH tenants BEFORE enabling RLS, so the read test starts from a
    // table that genuinely contains another tenant's rows.
    await admin.table(TABLE).multiInsert([
      { title: 'a1', tenant_id: tenantA },
      { title: 'mid', tenant_id: tenantB },
      { title: 'b1', tenant_id: tenantB },
    ])

    if (!rlsEnforced) return

    await admin.rawQuery(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`)
    await admin.rawQuery(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`)
    await admin.rawQuery(`DROP POLICY IF EXISTS ${POLICY} ON ${TABLE}`)
    await admin.rawQuery(
      `CREATE POLICY ${POLICY} ON ${TABLE} ` +
        `USING ("tenant_id"::text = nullif(current_setting('app.tenant_id', true), '')) ` +
        `WITH CHECK ("tenant_id"::text = nullif(current_setting('app.tenant_id', true), ''))`
    )
    // Let the least-privilege probe role read/write the table; RLS still
    // constrains which rows it sees (USING) and may write (WITH CHECK).
    await admin.rawQuery(`GRANT SELECT, INSERT ON ${TABLE} TO PUBLIC`)
    await admin.rawQuery(`GRANT USAGE, SELECT ON SEQUENCE ${TABLE}_id_seq TO PUBLIC`)
  })

  group.teardown(async () => {
    await db.connection('public').rawQuery(`DROP TABLE IF EXISTS ${TABLE}`)
  })

  test('a top-level orWhere cannot escape the tenant — RLS scopes it', async ({ assert }) => {
    const rows = await withTenantRls(
      tenantA,
      (trx) =>
        (trx as any)
          .from(TABLE)
          .where('title', 'a1')
          .orWhere('title', 'mid') // belongs to tenant B
          .orWhere('title', 'b1'), // belongs to tenant B
      { connectionName: PROBE_CONN }
    )

    assert.lengthOf(rows, 1, 'only tenant A row survives the policy')
    assert.equal(rows[0].title, 'a1')
    assert.isTrue(
      rows.every((r: any) => r.tenant_id === tenantA),
      'no other-tenant rows leak through the orWhere'
    )
  }).skip(() => !rlsEnforced, 'DB role is SUPERUSER/BYPASSRLS — RLS not enforced, proof skipped')

  test('a plain query with the setting unset returns nothing (fail-closed)', async ({ assert }) => {
    const result = await db.connection(PROBE_CONN).rawQuery(`SELECT * FROM ${TABLE}`)
    assert.lengthOf(rowsOf(result), 0, 'unset app.tenant_id matches no rows')
  }).skip(() => !rlsEnforced, 'DB role is SUPERUSER/BYPASSRLS — RLS not enforced, proof skipped')

  test('WITH CHECK blocks an insert owned by another tenant', async ({ assert }) => {
    // Assert it fails for the RIGHT reason (the policy), not because trx setup
    // or set_config threw — otherwise the test gives false confidence.
    await assert.rejects(
      () =>
        withTenantRls(
          tenantA,
          (trx) => (trx as any).table(TABLE).insert({ title: 'sneaky', tenant_id: tenantB }),
          { connectionName: PROBE_CONN }
        ),
      /row-level security|violates row-level/i
    )
  }).skip(() => !rlsEnforced, 'DB role is SUPERUSER/BYPASSRLS — RLS not enforced, proof skipped')
})
