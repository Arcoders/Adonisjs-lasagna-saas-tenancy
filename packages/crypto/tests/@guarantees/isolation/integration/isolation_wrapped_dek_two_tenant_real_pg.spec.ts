import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import {
  addTenantSchema,
  dropTenantSchema,
  probePg,
  rowsOfResult,
  serviceAs,
  tenant,
  type TenantSchema,
} from '../../../helpers/real_crypto_pg.js'

/**
 * The I1/I4 isolation proof on REAL Postgres: two tenants placed in two schemas via
 * `tableLocation`, each with its own wrapped-DEK table. A DEK provisioned for tenant
 * A is invisible to tenant B, and the same (subject × category) in both tenants
 * derives independent DEKs, so a ciphertext sealed for one never opens for the other.
 * Isolation is structural (different schemas), not because the data differs.
 * Self-skips when Postgres is unavailable, runs in CI.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const A = randomUUID()
const B = randomUUID()
const schemaA = `crypto_iso_a_${suffix}`
const schemaB = `crypto_iso_b_${suffix}`
const connA = `crypto_iso_conn_a_${suffix}`
const connB = `crypto_iso_conn_b_${suffix}`
const CAT = 'identity-docs'

let ready = false
let routes: Record<string, TenantSchema> = {}

test.group('crypto wrapped-DEK two-tenant isolation (real pg)', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return
    routes = {
      [A]: await addTenantSchema(schemaA, connA),
      [B]: await addTenantSchema(schemaB, connB),
    }
    return async () => {
      await dropTenantSchema(schemaA, connA)
      await dropTenantSchema(schemaB, connB)
    }
  })

  test("a DEK provisioned for tenant A is invisible to tenant B, and A's ciphertext does not open for B", async ({
    assert,
  }) => {
    const svcA = serviceAs(A, { routes })
    const svcB = serviceAs(B, { routes })

    const ciphertextA = await svcA.encryptField(tenant(A), 'renter-1', CAT, 'secret-of-A')
    // B has no DEK row for that (subject × category): fail-closed, never plaintext.
    await assert.rejects(
      () => svcB.decryptField(tenant(B), 'renter-1', CAT, ciphertextA),
      /no live DEK/
    )
    // A reads its own.
    assert.equal(await svcA.decryptField(tenant(A), 'renter-1', CAT, ciphertextA), 'secret-of-A')

    // Each schema holds its own rows.
    const nA = rowsOfResult(
      await db.connection(connA).rawQuery(`SELECT count(*)::int AS n FROM crypto_wrapped_deks`)
    )[0].n
    const nB = rowsOfResult(
      await db.connection(connB).rawQuery(`SELECT count(*)::int AS n FROM crypto_wrapped_deks`)
    )[0].n
    assert.equal(Number(nA), 1)
    assert.equal(Number(nB), 0)
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('the same (subject × category) in both tenants derives independent DEKs (I4)', async ({
    assert,
  }) => {
    const svcA = serviceAs(A, { routes })
    const svcB = serviceAs(B, { routes })

    // Same subject id + category + plaintext in BOTH tenants.
    const ciphertextA = await svcA.encryptField(tenant(A), 'shared', CAT, 'same-value')
    const ciphertextB = await svcB.encryptField(tenant(B), 'shared', CAT, 'same-value')
    assert.notEqual(ciphertextA, ciphertextB, 'independent DEKs (and random IVs) diverge')

    assert.equal(await svcA.decryptField(tenant(A), 'shared', CAT, ciphertextA), 'same-value')
    assert.equal(await svcB.decryptField(tenant(B), 'shared', CAT, ciphertextB), 'same-value')

    // A's DEK cannot open B's ciphertext (confused-deputy resistance): A's live DEK
    // exists, so the lookup succeeds, but the GCM tag fails under the wrong key.
    await assert.rejects(() => svcA.decryptField(tenant(A), 'shared', CAT, ciphertextB))
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
