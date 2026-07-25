import { test } from '@japa/runner'
import { withEncryptedFields } from '../../../../src/models/with_encrypted_fields.js'

/**
 * The mixin registers its encrypt/decrypt hooks exactly once per concrete model, even
 * when `withEncryptedFields` appears more than once in the chain (a direct double
 * `compose`, or a subclass whose ancestor already composed it). A double registration
 * would decrypt every row twice, and the second decrypt pass re-opens an
 * already-plaintext value and throws, so `find`/`fetch`/`paginate` would break. This
 * uses a counting base double so it needs no real Lucid or app container.
 */
function fakeBase() {
  const counts: Record<string, number> = {}
  const bump = (key: string) => (counts[key] = (counts[key] ?? 0) + 1)
  class Base {
    static booted = false
    static boot() {
      this.booted = true
    }
    static before(event: string) {
      bump(`before:${event}`)
    }
    static after(event: string) {
      bump(`after:${event}`)
    }
  }
  return { Base, counts }
}

const EXPECTED = {
  'before:create': 1,
  'before:update': 1,
  'after:create': 1,
  'after:update': 1,
  'after:find': 1,
  'after:fetch': 1,
}

test.group('crypto withEncryptedFields: hook registration', () => {
  test('composing once registers each hook exactly once (and no after:paginate)', ({ assert }) => {
    const { Base, counts } = fakeBase()
    const Model = withEncryptedFields(Base as any) as any
    Model.boot()
    assert.deepEqual(counts, EXPECTED)
    assert.isUndefined(
      counts['after:paginate'],
      'paginate is covered by after:fetch, not double-registered'
    )
  })

  test('composing TWICE still registers each hook exactly once (no double-fire)', ({ assert }) => {
    const { Base, counts } = fakeBase()
    // `compose(Base, withEncryptedFields, withEncryptedFields)` shape: two mixin layers
    // whose boot() closures both run in one cascade with the same `this`.
    const Model = withEncryptedFields(withEncryptedFields(Base as any) as any) as any
    Model.boot()
    assert.deepEqual(counts, EXPECTED)
  })

  test('boot is idempotent: booting the same model twice does not re-register', ({ assert }) => {
    const { Base, counts } = fakeBase()
    const Model = withEncryptedFields(Base as any) as any
    Model.boot()
    Model.boot()
    assert.deepEqual(counts, EXPECTED)
  })
})
