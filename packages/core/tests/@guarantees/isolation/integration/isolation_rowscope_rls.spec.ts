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
// The connection the proof executes on, least-privilege in CI.
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

    // Fail loud (rather than skip) whenever a least-privilege RLS role was
    // CONFIGURED but the proof still wouldn't be enforced. We key off
    // `RLS_DB_USER` (the env the CI workflow sets to point `rls_probe` at the
    // NOSUPERUSER `rls_ci` role) instead of a generic `CI` flag: that fires
    // exactly when the proof is meant to run, and won't surprise a local dev who
    // merely has `CI` exported but no RLS role provisioned. If the wiring drifts
    // (role/env renamed, connection misconfigured) the spec would otherwise go
    // GREEN by skipping and ship `rowscope-pg`'s headline guarantee unverified.
    if (!rlsEnforced && process.env.RLS_DB_USER) {
      throw new Error(
        `RLS proof cannot run: RLS_DB_USER="${process.env.RLS_DB_USER}" is set, but the ` +
          `"${PROBE_CONN}" connection still authenticated as a SUPERUSER/BYPASSRLS role, so the ` +
          `policy is not enforced. This is a hard failure — the role must be NOSUPERUSER ` +
          `NOBYPASSRLS and RLS_DB_USER/RLS_DB_PASSWORD must point at it (see ` +
          `.github/workflows/ci.yml). Refusing to pass by skipping.`
      )
    }

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
    // or set_config threw. Otherwise the test gives false confidence.
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

  test('a query that IGNORES the trx sees zero rows (the GUC is transaction-local)', async ({
    assert,
  }) => {
    // The documented footgun: `app.tenant_id` is set with set_config(..., is_local
    // => true), so it only applies to the trx that set it. A query that forgets to
    // run on `trx` lands on a different pooled connection where the setting is
    // unset, and RLS fail-closed returns NOTHING rather than leaking. Prove both
    // halves in one transaction: the trx sees its row, a sibling connection sees 0.
    const seen = await withTenantRls(
      tenantA,
      async (trx) => {
        const inTrx = await (trx as any).from(TABLE).select('*')
        // Same logical query, but on a SEPARATE pooled connection that ignores trx.
        const offTrx = await db.connection(PROBE_CONN).from(TABLE).select('*')
        return { inTrx, offTrx }
      },
      { connectionName: PROBE_CONN }
    )

    assert.isAbove(seen.inTrx.length, 0, 'the scoped trx must see the active tenant rows')
    assert.isTrue(
      seen.inTrx.every((r: any) => r.tenant_id === tenantA),
      'the scoped trx must see only tenant A'
    )
    assert.lengthOf(seen.offTrx, 0, 'a query off the trx has no GUC set, so RLS returns nothing')
  }).skip(() => !rlsEnforced, 'DB role is SUPERUSER/BYPASSRLS — RLS not enforced, proof skipped')

  test('the GUC does not leak to a reused pooled connection after commit', async ({ assert }) => {
    // Pin to a single physical backend (rls_probe_single is min=max=1) so the
    // transaction below and the bare query after it provably reuse the SAME
    // connection. If set_config used a session GUC instead of is_local, the value
    // would survive the commit and leak to whoever reuses the connection next.
    const SINGLE = 'rls_probe_single'

    const inTrx = await withTenantRls(tenantA, (trx) => (trx as any).from(TABLE).select('*'), {
      connectionName: SINGLE,
    })
    assert.isAbove(inTrx.length, 0, 'sanity: the scoped trx sees the active tenant rows')

    // Same connection, no transaction, no GUC set: the setting must be reset and
    // RLS must therefore return nothing.
    const settingRes = await db
      .connection(SINGLE)
      .rawQuery(`SELECT nullif(current_setting('app.tenant_id', true), '') AS guc`)
    assert.isNull(rowsOf(settingRes)[0].guc, 'app.tenant_id must be unset on the reused connection')

    const afterCommit = await db.connection(SINGLE).from(TABLE).select('*')
    assert.lengthOf(
      afterCommit,
      0,
      'no rows leak through the reused connection (GUC did not persist)'
    )
  }).skip(() => !rlsEnforced, 'DB role is SUPERUSER/BYPASSRLS — RLS not enforced, proof skipped')
})
