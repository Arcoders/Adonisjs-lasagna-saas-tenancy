import { test } from '@japa/runner'
import { assertWebSocketsConfig } from '../../src/validate_config.js'
import { normalizeAuthorize } from '../../src/resolve_authorize.js'
import { WEBSOCKETS_CONTRACT_VERSION } from '../../src/constants.js'
import type { WebSocketsConfig } from '../../src/types.js'

test.group('assertWebSocketsConfig', () => {
  test('accepts a fully specified valid config', ({ assert }) => {
    const config: WebSocketsConfig = {
      path: '/socket.io',
      cors: { origin: true },
      handshake: { authKey: 'tenantId' },
      authorize: () => true,
    }
    assert.doesNotThrow(() => assertWebSocketsConfig(config))
  })

  test('accepts an empty config (path and authorize are optional)', ({ assert }) => {
    assert.doesNotThrow(() => assertWebSocketsConfig({}))
  })

  test('throws when path is present but not a string', ({ assert }) => {
    assert.throws(
      () => assertWebSocketsConfig({ path: 123 as unknown as string }),
      '[websockets] config.websockets.path must be a string'
    )
  })

  test('throws when authorize is present but not a function', ({ assert }) => {
    assert.throws(
      () =>
        assertWebSocketsConfig({
          authorize: 'nope' as unknown as WebSocketsConfig['authorize'],
        }),
      '[websockets] config.websockets.authorize must be a function'
    )
  })

  test('accepts the versioned object form of authorize', ({ assert }) => {
    assert.doesNotThrow(() => assertWebSocketsConfig({ authorize: { authorize: () => true } }))
    assert.doesNotThrow(() =>
      assertWebSocketsConfig({
        authorize: { contractVersion: WEBSOCKETS_CONTRACT_VERSION, authorize: () => true },
      })
    )
  })

  test('throws when the object form lacks an authorize function', ({ assert }) => {
    assert.throws(
      () =>
        assertWebSocketsConfig({
          authorize: { contractVersion: 1 } as unknown as WebSocketsConfig['authorize'],
        }),
      /must be a function or/
    )
  })
})

test.group('normalizeAuthorize', () => {
  test('returns undefined when no authorize is configured', ({ assert }) => {
    assert.isUndefined(normalizeAuthorize(undefined))
  })

  test('passes a bare function through unversioned', ({ assert }) => {
    const fn = () => true
    assert.strictEqual(normalizeAuthorize(fn), fn)
  })

  test('unwraps the object form to its authorize function', ({ assert }) => {
    const fn = () => true
    assert.strictEqual(
      normalizeAuthorize({ contractVersion: WEBSOCKETS_CONTRACT_VERSION, authorize: fn }),
      fn
    )
  })

  test('rejects an object form built for a NEWER contract', ({ assert }) => {
    assert.throws(
      () =>
        normalizeAuthorize({
          contractVersion: WEBSOCKETS_CONTRACT_VERSION + 1,
          authorize: () => true,
        }),
      /requires extension contract/
    )
  })
})
