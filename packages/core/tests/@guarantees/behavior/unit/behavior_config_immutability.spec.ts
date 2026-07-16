import { test } from '@japa/runner'
import { setConfig, getConfig } from '../../../../src/config.js'
import { testConfig } from '../../../helpers/config.js'

/**
 * WS-5 / config-mutable-global-singleton.
 *
 * getConfig() returned a live, mutable reference to a process-wide singleton, so
 * any caller could `getConfig().isolation.driver = ...` and silently re-point
 * every tenant. And a second setConfig silently replaced the config at runtime.
 * The fix deep-freezes the config and refuses a second set in production.
 *
 * RED (pre-fix): config was mutable and a second prod set was silently accepted.
 */
test.group('config immutability', () => {
  test('getConfig() returns a deeply frozen object', ({ assert }) => {
    setConfig({ ...testConfig })
    const cfg = getConfig()
    assert.isTrue(Object.isFrozen(cfg), 'top-level config is frozen')
    assert.isTrue(Object.isFrozen(cfg.circuitBreaker), 'nested objects are frozen too')
    assert.throws(() => {
      ;(cfg as { tenantHeaderKey: string }).tenantHeaderKey = 'mutated'
    })
  })

  test('a stateful resolver instance in config is left mutable (not deep-frozen)', ({ assert }) => {
    // CFG-6: deepFreeze recurses into plain objects/arrays only. A class instance
    // (resolverChain/resolvers accept live resolver instances documented to hit a
    // cache or remote service) must keep owning its own state — freezing it would
    // break a stateful custom resolver.
    class StatefulResolver {
      cacheHits = 0
    }
    const resolver = new StatefulResolver()
    setConfig({ ...testConfig, resolvers: [resolver] } as unknown as typeof testConfig)
    const cfg = getConfig()
    assert.isTrue(Object.isFrozen(cfg), 'the plain config tree is still frozen')
    assert.isFalse(Object.isFrozen(resolver), 'the resolver instance is left mutable')
    assert.doesNotThrow(() => {
      resolver.cacheHits += 1
    })
    assert.equal(resolver.cacheHits, 1)
  })

  test('a second setConfig is refused in production', ({ assert }) => {
    const prev = process.env.NODE_ENV
    try {
      setConfig({ ...testConfig }) // first set (non-prod) — allowed
      process.env.NODE_ENV = 'production'
      assert.throws(() => setConfig({ ...testConfig }), /second time in production|immutable/)
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  test('repeated setConfig is allowed outside production (so test suites can re-seed)', ({
    assert,
  }) => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      assert.doesNotThrow(() => {
        setConfig({ ...testConfig })
        setConfig({ ...testConfig })
      })
    } finally {
      process.env.NODE_ENV = prev
    }
  })
})
