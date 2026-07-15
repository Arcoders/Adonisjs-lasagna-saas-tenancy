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
 * The field round-trip on real Postgres through the real PgWrappedDekStore: a value
 * is encrypted under a per-(subject × category) DEK whose wrapped row is inserted
 * into the tenant schema (via `tableLocation`), then decrypted back only through
 * that stored DEK. This exercises the actual raw-SQL insert/findLive path and the
 * partial-unique live row, not the in-memory double. Self-skips when Postgres is
 * unavailable (local), runs in CI.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const T = randomUUID()
const OTHER = randomUUID()
const schema = `crypto_rt_${suffix}`
const conn = `crypto_rt_conn_${suffix}`
const CAT = 'identity-docs'

let ready = false
let routes: Record<string, TenantSchema> = {}

test.group('crypto field round-trip through the real PgWrappedDekStore', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return
    routes = { [T]: await addTenantSchema(schema, conn) }
    return async () => dropTenantSchema(schema, conn)
  })

  test('encrypts, provisions a real DEK row, and decrypts back', async ({ assert }) => {
    const svc = serviceAs(T, { routes })
    const ciphertext = await svc.encryptField(tenant(T), 'renter-1', CAT, 'passport-AB1234567')
    assert.isTrue(ciphertext.startsWith('enc_v2:'), 'stored as enc_v2 ciphertext')
    assert.notInclude(ciphertext, 'passport-AB1234567')
    assert.equal(
      await svc.decryptField(tenant(T), 'renter-1', CAT, ciphertext),
      'passport-AB1234567'
    )

    // A real wrapped-DEK row landed in the tenant schema.
    const rows = rowsOfResult(
      await db
        .connection(conn)
        .rawQuery(
          `SELECT count(*)::int AS n FROM crypto_wrapped_deks WHERE subject_id = ? AND category = ? AND shredded_at IS NULL`,
          ['renter-1', CAT]
        )
    )
    assert.equal(Number(rows[0].n), 1)
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('reuses one live DEK across writes of the same (subject, category)', async ({ assert }) => {
    const svc = serviceAs(T, { routes })
    const a = await svc.encryptField(tenant(T), 'renter-2', CAT, 'first')
    const b = await svc.encryptField(tenant(T), 'renter-2', CAT, 'second')
    assert.equal(await svc.decryptField(tenant(T), 'renter-2', CAT, a), 'first')
    assert.equal(await svc.decryptField(tenant(T), 'renter-2', CAT, b), 'second')

    const rows = rowsOfResult(
      await db
        .connection(conn)
        .rawQuery(
          `SELECT count(*)::int AS n FROM crypto_wrapped_deks WHERE subject_id = ? AND category = ? AND shredded_at IS NULL`,
          ['renter-2', CAT]
        )
    )
    assert.equal(Number(rows[0].n), 1, 'exactly one live DEK row, reused')
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('a value for one subject cannot be read under another (fail-closed)', async ({ assert }) => {
    const svc = serviceAs(T, { routes })
    const ciphertext = await svc.encryptField(tenant(T), 'subject-A', CAT, 'secret')
    await assert.rejects(
      () => svc.decryptField(tenant(T), 'subject-B', CAT, ciphertext),
      /no live DEK/
    )
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('the ContextSeal refuses a query whose tenant differs from the active scope', async ({
    assert,
  }) => {
    // The service's active scope is OTHER, but we operate on tenant T: the store
    // re-asserts the request tenant equals the active scope before the raw query.
    const svc = serviceAs(OTHER, { routes: { ...routes, [OTHER]: routes[T] } })
    await assert.rejects(
      () => svc.encryptField(tenant(T), 'renter-3', CAT, 'x'),
      /does not match the active tenancy scope/
    )
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
