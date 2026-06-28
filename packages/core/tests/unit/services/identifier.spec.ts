import { test } from '@japa/runner'
import {
  assertSafeIdentifier,
  isUuidV4,
  isSafeIdentifier,
} from '../../../src/services/isolation/identifier.js'

test.group('assertSafeIdentifier', () => {
  test('accepts canonical UUID v4', ({ assert }) => {
    assert.doesNotThrow(() => assertSafeIdentifier('11111111-1111-4111-8111-111111111111'))
  })

  test('accepts short alphanumeric ids the host app may use', ({ assert }) => {
    assert.doesNotThrow(() => assertSafeIdentifier('acme123'))
    assert.doesNotThrow(() => assertSafeIdentifier('Tenant_42'))
    assert.doesNotThrow(() => assertSafeIdentifier('a-b-c'))
  })

  test('rejects empty strings', ({ assert }) => {
    assert.throws(() => assertSafeIdentifier(''))
  })

  test('rejects ids over 63 characters (Postgres NAMEDATALEN limit)', ({ assert }) => {
    const tooLong = 'a'.repeat(64)
    assert.throws(() => assertSafeIdentifier(tooLong))
  })

  test('rejects double quotes (the canonical PG identifier escape vector)', ({ assert }) => {
    assert.throws(() => assertSafeIdentifier('a"b'))
    assert.throws(() => assertSafeIdentifier('"'))
  })

  test('rejects semicolons and statement terminators', ({ assert }) => {
    assert.throws(() => assertSafeIdentifier('a; DROP DATABASE postgres; --'))
    assert.throws(() => assertSafeIdentifier('a;b'))
  })

  test('rejects whitespace and quotes', ({ assert }) => {
    assert.throws(() => assertSafeIdentifier('a b'))
    assert.throws(() => assertSafeIdentifier("a'b"))
    assert.throws(() => assertSafeIdentifier('a\nb'))
  })

  test('rejects shell metacharacters', ({ assert }) => {
    assert.throws(() => assertSafeIdentifier('a&b'))
    assert.throws(() => assertSafeIdentifier('a|b'))
    assert.throws(() => assertSafeIdentifier('a$(rm -rf)'))
  })

  test('rejects path traversal characters', ({ assert }) => {
    assert.throws(() => assertSafeIdentifier('../etc/passwd'))
    assert.throws(() => assertSafeIdentifier('a/b'))
    assert.throws(() => assertSafeIdentifier('a\\b'))
  })

  test('rejects non-string inputs', ({ assert }) => {
    assert.throws(() => assertSafeIdentifier(undefined as any))
    assert.throws(() => assertSafeIdentifier(null as any))
    assert.throws(() => assertSafeIdentifier(123 as any))
    assert.throws(() => assertSafeIdentifier({} as any))
  })

  test('error message names the kind for debuggability', ({ assert }) => {
    assert.throws(
      () => assertSafeIdentifier('a"b', 'tenant id'),
      /Refusing to use unsafe tenant id/
    )
  })
})

test.group('isUuidV4', () => {
  test('accepts canonical v4 uuids', ({ assert }) => {
    assert.isTrue(isUuidV4('11111111-1111-4111-8111-111111111111'))
    assert.isTrue(isUuidV4('aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee'))
  })

  test('rejects v3 uuids (wrong version bit)', ({ assert }) => {
    assert.isFalse(isUuidV4('11111111-1111-3111-8111-111111111111'))
  })

  test('rejects non-uuid strings', ({ assert }) => {
    assert.isFalse(isUuidV4('not-a-uuid'))
    assert.isFalse(isUuidV4(''))
    assert.isFalse(isUuidV4('11111111-1111-4111-c111-111111111111')) // bad variant
  })

  test('rejects non-string inputs', ({ assert }) => {
    assert.isFalse(isUuidV4(undefined as any))
    assert.isFalse(isUuidV4(null as any))
    assert.isFalse(isUuidV4(123 as any))
  })
})

test.group('isSafeIdentifier', () => {
  test('accepts UUID v4 and opaque alphanumeric host ids', ({ assert }) => {
    assert.isTrue(isSafeIdentifier('11111111-1111-4111-8111-111111111111'))
    assert.isTrue(isSafeIdentifier('acme123'))
    assert.isTrue(isSafeIdentifier('Tenant_42'))
    assert.isTrue(isSafeIdentifier('a-b-c'))
  })

  // The whole point of the seam guard: the Redis metric/rate-limit key uses ':'
  // as its delimiter, so a tenant id carrying ':' must be rejected before it can
  // inject key structure and forge another tenant's row.
  test('rejects ids carrying the key delimiter or structure-injection payloads', ({ assert }) => {
    assert.isFalse(isSafeIdentifier('victim:2026-06-28:requests'))
    assert.isFalse(isSafeIdentifier('a:b'))
    assert.isFalse(isSafeIdentifier('*'))
    assert.isFalse(isSafeIdentifier('metrics:*:2026-06-28:*'))
  })

  test('rejects empty, over-long, whitespace, and non-string inputs', ({ assert }) => {
    assert.isFalse(isSafeIdentifier(''))
    assert.isFalse(isSafeIdentifier('a'.repeat(64)))
    assert.isFalse(isSafeIdentifier('a b'))
    assert.isFalse(isSafeIdentifier(undefined))
    assert.isFalse(isSafeIdentifier(null))
    assert.isFalse(isSafeIdentifier(123))
  })

  test('agrees with assertSafeIdentifier on the same inputs', ({ assert }) => {
    for (const ok of ['11111111-1111-4111-8111-111111111111', 'acme123', 'a-b-c']) {
      assert.isTrue(isSafeIdentifier(ok))
      assert.doesNotThrow(() => assertSafeIdentifier(ok))
    }
    for (const bad of ['a:b', 'a"b', '', 'a b']) {
      assert.isFalse(isSafeIdentifier(bad))
      assert.throws(() => assertSafeIdentifier(bad))
    }
  })
})
