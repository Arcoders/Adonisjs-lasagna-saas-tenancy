import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { withTenantRls } from '@adonisjs-lasagna/saas-tenancy/services'
import {
  addRowscopeTable,
  centralConn,
  dropRowscopeTable,
  probePg,
  rowsOfResult,
  rowscopeServiceAs,
  tenant,
} from '../../../helpers/real_crypto_pg.js'
import { CRYPTO_WRAPPED_DEKS_TABLE } from '../../../../src/constants.js'

/**
 * RLS enforcement for the `rowscope-pg` wrapped-DEK table under a real
 * least-privilege role (defence-in-depth). The sibling smoke spec
 * (isolation_wrapped_dek_rowscope_two_tenant_real_pg.spec.ts) only proves the
 * shipped RLS DDL parses and the store's set_config path runs. It deliberately
 * does NOT assert cross-tenant blocking, because FORCE RLS is bypassed for the
 * superuser the central connection authenticates as locally. This spec closes that
 * gap: the proof runs on the `rls_probe` connection, which CI points at a NOSUPERUSER
 * NOBYPASSRLS role (via RLS_DB_USER/RLS_DB_PASSWORD), so the PostgreSQL policy is
 * genuinely enforced and a store-level bug can NOT hide behind a bypassing superuser.
 *
 * It proves, on the crypto wrapped-DEK table specifically:
 *   - a query with the GUC set to tenant A cannot see tenant B's wrapped DEK, even
 *     with a top-level orWhere the app predicate could not group (RLS scopes it);
 *   - WITH CHECK refuses an INSERT that stamps another tenant's id;
 *   - an unset GUC returns nothing (fail-closed), never every tenant's keys;
 *   - the shipped store round-trips a field under the same enforcing role, proving
 *     its set_config path is compatible with NOBYPASSRLS, not only with a superuser.
 *
 * Self-skips locally (central and rls_probe both resolve to the superuser, so RLS is
 * not enforced), and, mirroring core's RLS proof, fails loud rather than skipping when
 * RLS_DB_USER is set but the probe still authenticates as a bypassing role.
 */
const TABLE = CRYPTO_WRAPPED_DEKS_TABLE
const PROBE_CONN = 'rls_probe'
const A = randomUUID()
const B = randomUUID()
const CAT = 'identity-docs'

let rlsEnforced = false

/** Insert a wrapped-DEK row directly as the privileged (seeding) role. */
async function seedRow(tenantId: string, subjectId: string): Promise<void> {
  await db
    .connection(centralConn())
    .rawQuery(
      `INSERT INTO ${TABLE} (tenant_id, subject_id, category, wrapped_dek, kek_id) ` +
        `VALUES (?, ?, ?, ?, ?)`,
      [tenantId, subjectId, CAT, 'enc_v2:seed', 'env-seed']
    )
}

test.group('crypto wrapped-DEK rowscope RLS ENFORCED under least-privilege (real pg)', (group) => {
  group.setup(async () => {
    const ready = await probePg()
    if (!ready) return async () => {}

    // Does the probe role actually get RLS enforced? Superusers and BYPASSRLS
    // roles are exempt even under FORCE ROW LEVEL SECURITY. Check the role that
    // executes the proof, not the privileged DDL/seed role.
    const flagsRes = await db
      .connection(PROBE_CONN)
      .rawQuery(
        `select current_setting('is_superuser') = 'on' as super, ` +
          `coalesce((select rolbypassrls from pg_roles where rolname = current_user), false) as bypass`
      )
    const flags = rowsOfResult(flagsRes)[0] as { super?: boolean; bypass?: boolean }
    rlsEnforced = !(flags?.super === true || flags?.bypass === true)

    // Fail loud, never skip, when the enforcing role was configured (RLS_DB_USER
    // set, as CI does) but the probe still authenticated as a bypassing role. A
    // silent skip here would ship the crypto RLS guarantee unverified.
    if (!rlsEnforced && process.env.RLS_DB_USER) {
      throw new Error(
        `crypto RLS proof cannot run: RLS_DB_USER="${process.env.RLS_DB_USER}" is set, but the ` +
          `"${PROBE_CONN}" connection still authenticated as a SUPERUSER/BYPASSRLS role, so the ` +
          `policy is not enforced. The role must be NOSUPERUSER NOBYPASSRLS and ` +
          `RLS_DB_USER/RLS_DB_PASSWORD must point at it (see .github/workflows/ci.yml). ` +
          `Refusing to pass by skipping.`
      )
    }

    // Create the shared rowscope table with the shipped ENABLE/FORCE RLS and policy,
    // then let the least-privilege probe role read/write it (RLS still constrains
    // which rows it may see/insert via USING/WITH CHECK).
    await addRowscopeTable({ rls: true })
    await db
      .connection(centralConn())
      .rawQuery(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO PUBLIC`)

    return async () => {
      await dropRowscopeTable()
    }
  })

  // The shared table is reused across tests; reseed exactly one live row per tenant
  // before each so every proof starts from a table that does contain B's key.
  group.each.setup(async () => {
    if (!rlsEnforced) return
    await db.connection(centralConn()).rawQuery(`TRUNCATE ${TABLE}`)
    await seedRow(A, 'seed-subject')
    await seedRow(B, 'seed-subject')
  })

  test('a query scoped to A cannot see B’s wrapped DEK: a top-level orWhere cannot escape', async ({
    assert,
  }) => {
    const rows = await withTenantRls(
      A,
      (trx) =>
        (trx as any)
          .from(TABLE)
          .where('tenant_id', A)
          .orWhere('tenant_id', B) // belongs to tenant B, RLS must still hide it
          .select('tenant_id'),
      { connectionName: PROBE_CONN }
    )

    assert.lengthOf(rows, 1, 'only tenant A’s wrapped DEK survives the policy')
    assert.isTrue(
      rows.every((r: any) => r.tenant_id === A),
      'no other tenant’s wrapped DEK leaks through the orWhere'
    )
  }).skip(
    () => !rlsEnforced,
    'rls_probe is SUPERUSER/BYPASSRLS (local) — RLS not enforced, skipped'
  )

  test('WITH CHECK refuses an INSERT that stamps another tenant’s id', async ({ assert }) => {
    await assert.rejects(
      () =>
        withTenantRls(
          A,
          (trx) =>
            (trx as any).table(TABLE).insert({
              tenant_id: B, // scoped to A, but writing B's id
              subject_id: 'sneaky',
              category: CAT,
              wrapped_dek: 'enc_v2:x',
              kek_id: 'env-x',
            }),
          { connectionName: PROBE_CONN }
        ),
      /row-level security|violates row-level/i
    )
  }).skip(
    () => !rlsEnforced,
    'rls_probe is SUPERUSER/BYPASSRLS (local) — RLS not enforced, skipped'
  )

  test('an unset GUC returns nothing (fail-closed), never every tenant’s keys', async ({
    assert,
  }) => {
    const res = await db.connection(PROBE_CONN).rawQuery(`SELECT * FROM ${TABLE}`)
    assert.lengthOf(rowsOfResult(res), 0, 'unset app.tenant_id matches no wrapped DEK')
  }).skip(
    () => !rlsEnforced,
    'rls_probe is SUPERUSER/BYPASSRLS (local) — RLS not enforced, skipped'
  )

  test('the shipped store round-trips a field under the SAME enforcing role (set_config path)', async ({
    assert,
  }) => {
    // The store, driven over the NOBYPASSRLS probe connection, must open a trx, set
    // the GUC, and pass the forced policy on both INSERT (WITH CHECK) and SELECT
    // (USING). A store bug that forgot set_config would fail closed here, which is
    // what the superuser-run smoke spec cannot prove.
    const svc = rowscopeServiceAs(A, { rls: true, connectionName: PROBE_CONN })
    const ciphertext = await svc.encryptField(
      tenant(A),
      'renter-store',
      CAT,
      'secret-under-real-rls'
    )
    assert.match(ciphertext, /^enc_v2:/)
    assert.equal(
      await svc.decryptField(tenant(A), 'renter-store', CAT, ciphertext),
      'secret-under-real-rls'
    )
  }).skip(
    () => !rlsEnforced,
    'rls_probe is SUPERUSER/BYPASSRLS (local) — RLS not enforced, skipped'
  )
})
