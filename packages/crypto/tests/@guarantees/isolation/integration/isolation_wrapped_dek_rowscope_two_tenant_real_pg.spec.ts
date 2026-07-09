import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import {
  addRowscopeTable,
  centralConn,
  dropRowscopeTable,
  probePg,
  rowsOfResult,
  rowscopeServiceAs,
  rowscopeStoreAs,
  tenant,
} from '../../../helpers/real_crypto_pg.js'

/**
 * The I1/I4 isolation proof for the `rowscope-pg` placement on REAL Postgres: ONE
 * shared `crypto_wrapped_deks` table on the central connection, tenant separation by
 * the `tenant_id` scope column the store stamps + filters. Unlike schema-pg/database-pg,
 * isolation here is NOT structural (same physical table) — it is the store's always-on
 * `AND tenant_id = ?` predicate plus the satellite ContextSeal. This spec proves that
 * predicate holds: A's DEK is invisible to B, the same (subject × category) coexists per
 * tenant (the per-(tenant, subject, category) partial UNIQUE), and the store still refuses
 * a cross-tenant query. Self-skips when Postgres is unavailable, runs in CI.
 */
const A = randomUUID()
const B = randomUUID()
const CAT = 'identity-docs'

let ready = false

async function countRows(where = '', bindings: unknown[] = []): Promise<number> {
  const sql = `SELECT count(*)::int AS n FROM crypto_wrapped_deks ${where}`
  const res = await db.connection(centralConn()).rawQuery(sql, bindings)
  return Number(rowsOfResult(res)[0].n)
}

test.group('crypto wrapped-DEK rowscope two-tenant isolation (real pg)', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return
    await addRowscopeTable()
    return async () => {
      await dropRowscopeTable()
    }
  })

  // The shared table is reused across tests, so start each one from empty.
  group.each.setup(async () => {
    if (ready) await db.connection(centralConn()).rawQuery('TRUNCATE crypto_wrapped_deks')
  })

  test("a DEK provisioned for tenant A is invisible to tenant B, and A's ciphertext does not open for B", async ({
    assert,
  }) => {
    const svcA = rowscopeServiceAs(A)
    const svcB = rowscopeServiceAs(B)

    const ciphertextA = await svcA.encryptField(tenant(A), 'renter-1', CAT, 'secret-of-A')
    // B's scoped read finds no row (the store filters tenant_id = B): fail-closed.
    await assert.rejects(
      () => svcB.decryptField(tenant(B), 'renter-1', CAT, ciphertextA),
      /no live DEK/
    )
    assert.equal(await svcA.decryptField(tenant(A), 'renter-1', CAT, ciphertextA), 'secret-of-A')

    // The shared table holds A's row and only A's — the tenant_id scope is what separates.
    assert.equal(await countRows(), 1)
    assert.equal(await countRows('WHERE tenant_id = ?', [A]), 1)
    assert.equal(await countRows('WHERE tenant_id = ?', [B]), 0)
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('the same (subject × category) coexists per tenant and derives independent DEKs (I4)', async ({
    assert,
  }) => {
    const svcA = rowscopeServiceAs(A)
    const svcB = rowscopeServiceAs(B)

    // Same subject id + category + plaintext in BOTH tenants: no dek_conflict, because
    // the live-DEK UNIQUE is per (tenant_id, subject_id, category).
    const ciphertextA = await svcA.encryptField(tenant(A), 'shared', CAT, 'same-value')
    const ciphertextB = await svcB.encryptField(tenant(B), 'shared', CAT, 'same-value')
    assert.notEqual(ciphertextA, ciphertextB, 'independent DEKs (and random IVs) diverge')

    assert.equal(await svcA.decryptField(tenant(A), 'shared', CAT, ciphertextA), 'same-value')
    assert.equal(await svcB.decryptField(tenant(B), 'shared', CAT, ciphertextB), 'same-value')
    // A's DEK cannot open B's ciphertext (GCM tag fails under the wrong key).
    await assert.rejects(() => svcA.decryptField(tenant(A), 'shared', CAT, ciphertextB))

    // Two independent live rows, one per tenant, same (subject, category).
    assert.equal(await countRows(`WHERE subject_id = 'shared' AND category = ?`, [CAT]), 2)
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('the satellite ContextSeal refuses a cross-tenant query on the shared table', async ({
    assert,
  }) => {
    // Raw SQL bypasses the kernel ContextSeal; the store re-asserts the request tenant
    // equals the active scope BEFORE any query, so a store scoped to A cannot read B.
    const storeScopedToA = rowscopeStoreAs(A)
    await assert.rejects(
      () => storeScopedToA.findLive(tenant(B), 'renter-1', CAT),
      /active tenancy scope/
    )
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('the per-(tenant, subject, category) partial UNIQUE allows re-provision after a shred', async ({
    assert,
  }) => {
    const storeA = rowscopeStoreAs(A)
    const storeB = rowscopeStoreAs(B)
    const row = { subjectId: 'renter-9', category: CAT, wrappedDek: 'enc_v2:a', kekId: 'env-a' }

    await storeA.insert(tenant(A), row)
    // A second LIVE insert for the same (tenant, subject, category) is a conflict.
    await assert.rejects(() => storeA.insert(tenant(A), row), /already exists/)
    // A different tenant with the same (subject, category) is fine — the UNIQUE includes tenant_id.
    await storeB.insert(tenant(B), { ...row, wrappedDek: 'enc_v2:b', kekId: 'env-b' })

    // Shred A's live DEK (tombstone), then re-provision: a fresh live row is allowed.
    assert.isTrue(await storeA.shredLive(tenant(A), 'renter-9', CAT))
    await storeA.insert(tenant(A), { ...row, wrappedDek: 'enc_v2:a2' })

    // A now has a tombstone + a fresh live row; its live lookup returns the new one.
    const live = await storeA.findLive(tenant(A), 'renter-9', CAT)
    assert.equal(live?.wrappedDek, 'enc_v2:a2')
    assert.equal(await countRows('WHERE tenant_id = ?', [A]), 2) // tombstone + live
    assert.equal(await countRows('WHERE tenant_id = ?', [B]), 1)
  }).skip(() => !ready, 'postgres not available; runs in CI')
})

/**
 * A smoke test that the SHIPPED stub's RLS DDL is valid and the store's rls branch
 * (transaction + set_config of the GUC) works end-to-end against a real RLS-enabled
 * table. Enrolling the stub's ENABLE/FORCE ROW LEVEL SECURITY + policy verbatim, then
 * driving the store with rls:true, proves: the policy DDL parses/applies, the GUC name
 * agrees with the store's rlsGuc, and set_config(is_local=true) lets the store's own
 * INSERT/SELECT pass the policy's USING/WITH CHECK. It does NOT assert cross-tenant
 * BLOCKING — FORCE RLS is bypassed for a superuser (the likely local role), and RLS
 * ENFORCEMENT is core's tested concern (isolation_rowscope_rls.spec). Runs wherever PG
 * is reachable.
 */
let rlsReady = false

test.group('crypto wrapped-DEK rowscope RLS smoke (real pg)', (group) => {
  group.setup(async () => {
    rlsReady = await probePg()
    if (!rlsReady) return
    await addRowscopeTable({ rls: true })
    return async () => {
      await dropRowscopeTable()
    }
  })

  test('the store round-trips a field under the stub’s FORCED RLS policy (set_config path)', async ({
    assert,
  }) => {
    const svc = rowscopeServiceAs(A, { rls: true })
    const ciphertext = await svc.encryptField(tenant(A), 'renter-1', CAT, 'secret-under-rls')
    assert.notEqual(ciphertext, 'secret-under-rls')
    // The read runs the store's rls branch: a transaction that first set_config's the
    // GUC, so the SELECT passes the FORCED policy. A wrong GUC name or a broken policy
    // would make this fail closed (zero rows -> 'no live DEK').
    assert.equal(await svc.decryptField(tenant(A), 'renter-1', CAT, ciphertext), 'secret-under-rls')
    assert.equal(await countRows('WHERE tenant_id = ?', [A]), 1)
  }).skip(() => !rlsReady, 'postgres not available; runs in CI')
})
