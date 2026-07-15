import { test } from '@japa/runner'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  addTenantSchema,
  dropTenantSchema,
  harnessAs,
  probePg,
  tenant,
  type TenantSchema,
} from '../../../helpers/real_crypto_pg.js'

/**
 * KEK rotation (rekek) on real Postgres through the real PgWrappedDekStore and
 * EnvKeyProvider. Under the env provider a KEK rotation is an APP_KEY rotation, so
 * the spec drives the real rotation window: it provisions DEKs under one APP_KEY,
 * then sets `OLD_APP_KEY` to it and `APP_KEY` to a new key, and runs the rekek
 * walker. It asserts the load-bearing properties end-to-end:
 *   - every live DEK is re-wrapped under the new KEK generation (`kek_id` changes);
 *   - the field data is untouched and still decrypts (the DEK bytes are preserved,
 *     never re-encrypted);
 *   - the pass is idempotent (a re-run finds everything current);
 *   - with the DEK now on the new generation, decryption works even after
 *     `OLD_APP_KEY` is removed (the rotation is complete);
 *   - a DEK whose generation the provider no longer holds is reported `failed`,
 *     never silently rotated (it fails closed).
 * Self-skips when Postgres is unreachable (local), runs in CI.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const schema = `crypto_rekek_${suffix}`
const conn = `crypto_rekek_conn_${suffix}`
const CAT = 'identity-docs'

let ready = false
let routes: Record<string, TenantSchema> = {}
let originalAppKey: string | undefined
let T: string

/** A fresh, distinct APP_KEY value (any non-empty string keys the env HKDF). */
function freshKey(): string {
  return `rekek_${randomBytes(24).toString('base64url')}`
}

function restoreEnv(): void {
  if (originalAppKey === undefined) delete process.env.APP_KEY
  else process.env.APP_KEY = originalAppKey
  delete process.env.OLD_APP_KEY
}

test.group('crypto KEK rotation (rekek) on real Postgres', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return
    originalAppKey = process.env.APP_KEY
    return async () => {
      restoreEnv()
    }
  })

  group.each.setup(async () => {
    if (!ready) return
    // A fresh tenant schema + a fresh APP_KEY baseline per test, so tests never
    // leak generation state into each other.
    T = randomUUID()
    process.env.APP_KEY = freshKey()
    delete process.env.OLD_APP_KEY
    const s = `${schema}_${T.slice(0, 8)}`
    const c = `${conn}_${T.slice(0, 8)}`
    routes = { [T]: await addTenantSchema(s, c) }
    return async () => {
      await dropTenantSchema(s, c)
      restoreEnv()
    }
  })

  test('re-wraps every DEK under the new KEK; data still decrypts; idempotent', async ({
    assert,
  }) => {
    const oldKey = process.env.APP_KEY!
    const { crypto, rekek, store, keyProvider } = harnessAs(T, { routes })

    // 1. Provision + encrypt two subjects under the old APP_KEY generation.
    const ct1 = await crypto.encryptField(tenant(T), 'renter-1', CAT, 'passport-AB1234567')
    const ct2 = await crypto.encryptField(tenant(T), 'renter-2', CAT, 'national-ID-99')
    const oldKekId = await keyProvider.currentKekId(T)
    const before = await store.listLive(tenant(T))
    assert.equal(before.length, 2)
    assert.isTrue(before.every((r) => r.kekId === oldKekId))

    // 2. Rotate: the previous key becomes OLD_APP_KEY, a new key becomes APP_KEY.
    process.env.OLD_APP_KEY = oldKey
    process.env.APP_KEY = freshKey()
    const newKekId = await keyProvider.currentKekId(T)
    assert.notEqual(newKekId, oldKekId)

    // 3. Run the walker.
    const summary = await rekek.rekekTenant(tenant(T))
    assert.deepEqual(
      {
        scanned: summary.scanned,
        current: summary.current,
        rotated: summary.rotated,
        failed: summary.failed,
      },
      { scanned: 2, current: 0, rotated: 2, failed: 0 }
    )

    // Every row is now on the new generation, and the data still decrypts: the DEK
    // bytes were preserved, so the ciphertext was never re-encrypted.
    const after = await store.listLive(tenant(T))
    assert.isTrue(after.every((r) => r.kekId === newKekId))
    assert.equal(await crypto.decryptField(tenant(T), 'renter-1', CAT, ct1), 'passport-AB1234567')
    assert.equal(await crypto.decryptField(tenant(T), 'renter-2', CAT, ct2), 'national-ID-99')

    // 4. Idempotent: a second pass finds everything current, writes nothing.
    const second = await rekek.rekekTenant(tenant(T))
    assert.deepEqual(
      { current: second.current, rotated: second.rotated, failed: second.failed },
      { current: 2, rotated: 0, failed: 0 }
    )

    // 5. Rotation complete: drop OLD_APP_KEY; decryption still works because every
    // DEK is now wrapped under the current (new) KEK.
    delete process.env.OLD_APP_KEY
    assert.equal(await crypto.decryptField(tenant(T), 'renter-1', CAT, ct1), 'passport-AB1234567')
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('a DEK the provider can no longer unwrap is reported failed, then recovers via OLD_APP_KEY', async ({
    assert,
  }) => {
    const { crypto, rekek, store, keyProvider } = harnessAs(T, { routes })

    // Provision under the current key and remember it: it is the key that wrapped
    // this DEK, and the only key that can unwrap it.
    const ct = await crypto.encryptField(tenant(T), 'renter-x', CAT, 'passport-ZZ0000000')
    const prevKey = process.env.APP_KEY!
    const strandedKekId = await keyProvider.currentKekId(T)

    // Rotate APP_KEY without exposing the previous key: the walker cannot unwrap it.
    process.env.APP_KEY = freshKey()
    delete process.env.OLD_APP_KEY

    const failedPass = await rekek.rekekTenant(tenant(T))
    assert.equal(failedPass.failed, 1)
    assert.equal(failedPass.rotated, 0)
    assert.equal(failedPass.failures[0].subjectId, 'renter-x')
    // Fail-closed: the row is left untouched at its old generation (nothing bricked).
    assert.equal((await store.listLive(tenant(T)))[0].kekId, strandedKekId)

    // Recover: expose the previous key via OLD_APP_KEY and re-run; it re-wraps.
    process.env.OLD_APP_KEY = prevKey
    const recovered = await rekek.rekekTenant(tenant(T))
    assert.equal(recovered.rotated, 1)
    assert.equal(recovered.failed, 0)
    assert.equal((await store.listLive(tenant(T)))[0].kekId, await keyProvider.currentKekId(T))
    // The data survived the whole ordeal.
    delete process.env.OLD_APP_KEY
    assert.equal(await crypto.decryptField(tenant(T), 'renter-x', CAT, ct), 'passport-ZZ0000000')
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
