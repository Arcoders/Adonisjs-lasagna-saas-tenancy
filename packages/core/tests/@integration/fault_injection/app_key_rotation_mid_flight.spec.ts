import { test } from '@japa/runner'
import { encrypt, decryptWithAppKey, readSecret, writeSecret } from '@adonisjs-lasagna/saas-tenancy'

/**
 * Fault injection (WS-1): the secret-at-rest invariant under an APP_KEY rotation.
 *
 * A secret written under the OLD key (and the legacy shared context) must, after
 * the key is rotated, be read FAIL-CLOSED by the canonical accessor: never
 * silently passed through or signed with the wrong bytes. It stays fail-closed
 * until `tenant:secrets:reencrypt` recovers the plaintext with the old key and
 * re-encrypts it under the current key + per-class context. This pins the
 * "fail-closed until re-encrypted, then succeed" lifecycle at the seam level,
 * independent of the database the command iterates.
 */

const OLD_KEY = 'rotation-chaos-old-app-key-aaaaaaaaaa'
const NEW_KEY = 'rotation-chaos-new-app-key-bbbbbbbbbb'

function withAppKey<T>(key: string, fn: () => T): T {
  const prev = process.env.APP_KEY
  process.env.APP_KEY = key
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = prev
  }
}

test.group('fault: APP_KEY rotation mid-flight (secret-at-rest)', () => {
  test('a legacy secret reads fail-closed after rotation, then succeeds once re-encrypted', ({
    assert,
  }) => {
    const plaintext = 'whsec_rotate-me-across-keys'

    // 1. Written under the OLD key + legacy default context (pre-upgrade row).
    const stored = withAppKey(OLD_KEY, () => encrypt(plaintext))

    // 2. APP_KEY is rotated to the NEW key. The canonical read fails closed:
    //    wrong key AND wrong class context.
    withAppKey(NEW_KEY, () => {
      assert.throws(() => readSecret(stored, 'webhookSecret'))
    })

    // 3. The migration recovers the plaintext with the OLD key and re-encrypts
    //    under the NEW key + the per-class context (what reencrypt does per row).
    const migrated = withAppKey(NEW_KEY, () => {
      const recovered = decryptWithAppKey(stored, OLD_KEY) // old key, legacy context
      return writeSecret(recovered, 'webhookSecret') // new key, class context
    })

    // 4. The canonical read now succeeds under the current key + class.
    withAppKey(NEW_KEY, () => {
      assert.equal(readSecret(migrated, 'webhookSecret'), plaintext)
    })
  })
})
