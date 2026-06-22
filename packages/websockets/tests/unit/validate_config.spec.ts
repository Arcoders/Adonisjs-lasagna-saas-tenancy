import { test } from '@japa/runner'
import { assertWebSocketsConfig } from '../../src/validate_config.js'
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
})
