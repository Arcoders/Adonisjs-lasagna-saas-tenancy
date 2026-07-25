import { test } from '@japa/runner'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
  type AiIdempotencyScope,
} from '../../../../src/gateway/idempotency.js'

/**
 * Key scoping: the cache key is an HMAC binding tenant + principal + session + header
 * key together. Changing ANY scope component (or the epoch) must move the entry, and no
 * raw scope component may ever appear in a key.
 */

function service(): AiIdempotencyService {
  return new AiIdempotencyService({
    store: {
      async get() {
        return undefined
      },
      async set() {},
    },
    macKey: deriveAiIdempotencyMacKey('app-key-under-test'),
  })
}

const base: AiIdempotencyScope = {
  tenantId: 'tenant-a',
  principal: 'user-1',
  sessionId: 'session-1',
  headerKey: 'retry-123',
}

test.group('idempotency key scoping', () => {
  test('every scope component moves the key', ({ assert }) => {
    const svc = service()
    const reference = svc.entryKey(base, '0')
    const variants: AiIdempotencyScope[] = [
      { ...base, tenantId: 'tenant-b' },
      { ...base, principal: 'user-2' },
      { ...base, sessionId: 'session-2' },
      { ...base, sessionId: null },
      { ...base, headerKey: 'retry-124' },
    ]
    const keys = new Set([reference, ...variants.map((scope) => svc.entryKey(scope, '0'))])
    assert.equal(keys.size, variants.length + 1, 'every variant must produce a distinct key')
  })

  test('the epoch segments the keyspace (the purge seam)', ({ assert }) => {
    const svc = service()
    assert.notEqual(svc.entryKey(base, '0'), svc.entryKey(base, 'deadbeef'))
  })

  test('the key is deterministic for identical inputs', ({ assert }) => {
    const svc = service()
    assert.equal(svc.entryKey(base, '0'), svc.entryKey(base, '0'))
  })

  test('no raw scope component leaks into the key', ({ assert }) => {
    const key = service().entryKey(base, '0')
    for (const fragment of ['tenant-a', 'user-1', 'session-1', 'retry-123']) {
      assert.notInclude(key, fragment)
    }
    assert.match(key, /^ai:idem:0:[0-9a-f]{64}$/)
  })

  test('a session-less scope is distinct from an empty-string session only via the MAC input framing', ({
    assert,
  }) => {
    // sessionId null and undefined both normalize to the empty segment: a
    // caller cannot mint a second cache slot by flapping between them.
    const svc = service()
    assert.equal(
      svc.entryKey({ ...base, sessionId: null }, '0'),
      // The type's optional sessionId does not admit an explicit undefined under
      // exactOptionalPropertyTypes, but the runtime normalizes undefined and null
      // identically, which is exactly what this test pins, so pass it deliberately.
      svc.entryKey({ ...base, sessionId: undefined } as unknown as AiIdempotencyScope, '0')
    )
  })

  test('different APP_KEYs derive unrelated keyspaces', ({ assert }) => {
    const a = new AiIdempotencyService({
      store: { get: async () => undefined, set: async () => {} },
      macKey: deriveAiIdempotencyMacKey('app-key-a'),
    })
    const b = new AiIdempotencyService({
      store: { get: async () => undefined, set: async () => {} },
      macKey: deriveAiIdempotencyMacKey('app-key-b'),
    })
    assert.notEqual(a.entryKey(base, '0'), b.entryKey(base, '0'))
  })
})
