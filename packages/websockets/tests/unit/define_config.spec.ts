import { test } from '@japa/runner'
import {
  defineWebSocketsConfig,
  type MultitenancyConfigWithWebsockets,
} from '../../src/define_config.js'

/**
 * WS-7 / satellite-config-wiring-four-patterns.
 *
 * Every config-bearing satellite must expose the same authoring surface as
 * reporting: a `define<X>Config` identity helper and a `MultitenancyConfigWith<X>`
 * merged type. This pins the websockets pair (the guard
 * check-satellite-config-wiring.mjs covers all four satellites).
 *
 * RED (pre-fix): websockets had only a provider-local type and no define helper.
 */
test.group('defineWebSocketsConfig', () => {
  test('returns its input unchanged (identity helper)', ({ assert }) => {
    const cfg = { path: '/ws', authorize: () => true }
    assert.strictEqual(defineWebSocketsConfig(cfg as any), cfg)
  })

  test('the merged config type is usable for authoring', ({ assert }) => {
    const full: MultitenancyConfigWithWebsockets = {
      websockets: defineWebSocketsConfig({ path: '/ws' } as any),
    } as MultitenancyConfigWithWebsockets
    assert.equal(full.websockets?.path, '/ws')
  })
})
