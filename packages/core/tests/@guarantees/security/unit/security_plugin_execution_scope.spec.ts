import { test } from '@japa/runner'
import { pluginScope } from '../../../../src/services/plugin_execution_scope.js'
import { pluginName } from '../../../../src/sdk/brands.js'

/**
 * The plugin execution scope is the load-bearing primitive for the S3 read-only
 * routing and the S5 core-access proxies: everything downstream gates on "is
 * untrusted plugin code on the stack right now?". These tests pin the trust
 * predicate and the AsyncLocalStorage propagation (async continuations + nesting
 * + fail-closed default) so a later slice can rely on it without re-proving it.
 */

const TRUSTED = { plugin: pluginName('reporting'), trusted: true } as const
const UNTRUSTED = { plugin: pluginName('sketchy'), trusted: false } as const

test.group('plugin execution scope — trust predicate', () => {
  test('outside any scope, core code reads as trusted (no untrusted active)', ({ assert }) => {
    assert.isUndefined(pluginScope.current())
    assert.isFalse(pluginScope.untrustedActive())
  })

  test('inside a trusted plugin scope, current() reports it and untrustedActive() is false', ({
    assert,
  }) => {
    pluginScope.run(TRUSTED, () => {
      assert.deepEqual(pluginScope.current(), TRUSTED)
      assert.isFalse(pluginScope.untrustedActive())
    })
  })

  test('inside an untrusted plugin scope, untrustedActive() is true', ({ assert }) => {
    pluginScope.run(UNTRUSTED, () => {
      assert.deepEqual(pluginScope.current(), UNTRUSTED)
      assert.isTrue(pluginScope.untrustedActive())
    })
  })

  test('the scope is cleared once run() returns', ({ assert }) => {
    pluginScope.run(UNTRUSTED, () => {})
    assert.isUndefined(pluginScope.current())
    assert.isFalse(pluginScope.untrustedActive())
  })
})

test.group('plugin execution scope — async + nesting', () => {
  test('the scope survives an async continuation (await inside fn)', async ({ assert }) => {
    await pluginScope.run(UNTRUSTED, async () => {
      await Promise.resolve()
      assert.isTrue(pluginScope.untrustedActive())
      assert.equal(pluginScope.current()?.plugin, 'sketchy')
    })
    assert.isFalse(pluginScope.untrustedActive())
  })

  test('an inner scope shadows an outer one and the outer is restored on exit', ({ assert }) => {
    pluginScope.run(TRUSTED, () => {
      assert.isFalse(pluginScope.untrustedActive())
      pluginScope.run(UNTRUSTED, () => {
        assert.isTrue(pluginScope.untrustedActive())
        assert.equal(pluginScope.current()?.plugin, 'sketchy')
      })
      // outer trusted scope restored
      assert.isFalse(pluginScope.untrustedActive())
      assert.equal(pluginScope.current()?.plugin, 'reporting')
    })
  })

  test('run() returns whatever fn returns', ({ assert }) => {
    const value = pluginScope.run(TRUSTED, () => 42)
    assert.equal(value, 42)
  })

  test('run() propagates a throw and still clears the scope', ({ assert }) => {
    assert.throws(() => {
      pluginScope.run(UNTRUSTED, () => {
        throw new Error('boom')
      })
    }, /boom/)
    assert.isUndefined(pluginScope.current())
    assert.isFalse(pluginScope.untrustedActive())
  })
})
