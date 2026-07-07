import { test } from '@japa/runner'
import {
  assertPluginLimits,
  type PluginSurfaceCounts,
} from '../../../../src/providers/assert_plugin_limits.js'
import type { PluginLimitsConfig } from '../../../../src/types/config.js'

/**
 * Fail-closed cap enforcement for the plugin request-path surfaces. The
 * load-bearing guarantee: a surface whose registered count EXCEEDS its configured
 * cap aborts boot with a typed PluginBootException; a count at-or-below the cap
 * passes, and an omitted cap (or an omitted block) is unlimited — byte-identical
 * to the pre-cap behavior. Pure, so it runs without an Ignitor (mirrors
 * assertConfigBounds).
 */

const zero: PluginSurfaceCounts = { authorizers: 0, middleware: 0, capabilities: 0 }

test.group('assertPluginLimits()', () => {
  test('no limits block → never throws, whatever the counts', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertPluginLimits(undefined, { authorizers: 999, middleware: 999, capabilities: 999 })
    )
  })

  test('a block with every cap omitted → unlimited', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertPluginLimits({}, { authorizers: 999, middleware: 999, capabilities: 999 })
    )
  })

  test('a count AT the cap passes; one OVER throws', ({ assert }) => {
    const limits: PluginLimitsConfig = { maxAuthorizers: 2 }
    assert.doesNotThrow(() => assertPluginLimits(limits, { ...zero, authorizers: 2 }))
    assert.throws(
      () => assertPluginLimits(limits, { ...zero, authorizers: 3 }),
      /3 tenant-access authorizers are registered but multitenancy\.plugins\.limits\.maxAuthorizers caps it at 2/
    )
  })

  test('each surface is capped independently', ({ assert }) => {
    assert.throws(
      () => assertPluginLimits({ maxMiddleware: 1 }, { ...zero, middleware: 2 }),
      /plugin route middleware are registered but multitenancy\.plugins\.limits\.maxMiddleware caps it at 1/
    )
    assert.throws(
      () => assertPluginLimits({ maxCapabilities: 0 }, { ...zero, capabilities: 1 }),
      /provided capabilities are registered but multitenancy\.plugins\.limits\.maxCapabilities caps it at 0/
    )
  })

  test('the abort is a typed PluginBootException (E_PLUGIN_BOOT / 500 / phase=limits)', ({
    assert,
  }) => {
    try {
      assertPluginLimits({ maxAuthorizers: 0 }, { ...zero, authorizers: 1 })
      assert.fail('expected assertPluginLimits to throw')
    } catch (err: any) {
      assert.equal(err.code, 'E_PLUGIN_BOOT')
      assert.equal(err.status, 500)
      assert.equal(err.phase, 'limits')
    }
  })
})
