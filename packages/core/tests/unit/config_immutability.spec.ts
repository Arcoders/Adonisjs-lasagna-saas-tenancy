import { test } from '@japa/runner'
import { setConfig, getConfig, getConfigVersion } from '../../src/config.js'
import { testConfig } from '../helpers/config.js'

/**
 * WS-5 / config-mutable-global-singleton.
 *
 * getConfig() returned a live, mutable reference to a process-wide singleton, so
 * any caller could `getConfig().isolation.driver = ...` and silently re-point
 * every tenant. And a second setConfig silently replaced the config at runtime.
 * The fix deep-freezes the config, refuses a second set in production, and bumps
 * a version envelope.
 *
 * RED (pre-fix): config was mutable, a second prod set was silently accepted,
 * and there was no version.
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

  test('setConfig bumps the version envelope', ({ assert }) => {
    const before = getConfigVersion()
    setConfig({ ...testConfig })
    assert.equal(getConfigVersion(), before + 1)
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
