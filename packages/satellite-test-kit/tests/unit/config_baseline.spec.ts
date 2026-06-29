import { test } from '@japa/runner'
import { createConfigBaselineGuard } from '../../src/config_baseline.js'

/**
 * Chaos test for the integration-suite isolation backstop. It injects config
 * chaos (a leaked swap that a spec failed to restore) and proves the guard
 * detects it, names the group, and restores the boot baseline so the next spec is
 * not poisoned. The no-leak path must stay a silent no-op so a well-behaved spec
 * can never trip a false positive.
 */
test.group('config baseline guard', () => {
  function harness(initial: object) {
    let current = initial
    const sets: object[] = []
    const warns: string[] = []
    const guard = createConfigBaselineGuard<object>({
      getConfig: () => current,
      setConfig: (c) => {
        current = c
        sets.push(c)
      },
      warn: (m) => warns.push(m),
    })
    return {
      guard,
      sets,
      warns,
      leak: (c: object) => {
        current = c
      },
      get current() {
        return current
      },
    }
  }

  test('a no-leak group is a silent no-op', ({ assert }) => {
    const h = harness({ a: 1 })
    h.guard.onGroupStart()
    const restored = h.guard.onGroupEnd('clean-group')
    assert.isFalse(restored)
    assert.lengthOf(h.warns, 0)
    assert.lengthOf(h.sets, 0)
  })

  test('a leaked config swap is detected, named, and restored', ({ assert }) => {
    const baseline = { a: 1 }
    const h = harness(baseline)
    h.guard.onGroupStart() // snapshot the boot baseline
    h.leak({ a: 999 }) // a spec swapped the config and never restored it
    const restored = h.guard.onGroupEnd('leaky-group')
    assert.isTrue(restored)
    assert.lengthOf(h.warns, 1)
    assert.match(h.warns[0], /leaky-group/)
    assert.strictEqual(h.current, baseline) // restored by identity to the boot baseline
    assert.lengthOf(h.sets, 1)
    assert.strictEqual(h.sets[0], baseline)
  })

  test('it snapshots once: a later group keeps the original baseline', ({ assert }) => {
    const baseline = { a: 1 }
    const h = harness(baseline)
    h.guard.onGroupStart() // baseline = the {a:1} object
    h.leak({ a: 2 })
    h.guard.onGroupEnd('g1') // restores to baseline
    assert.strictEqual(h.current, baseline)
    // A second group: onGroupStart must NOT re-baseline off a (hypothetically) drifted config.
    h.guard.onGroupStart()
    h.leak({ a: 3 })
    h.guard.onGroupEnd('g2')
    assert.strictEqual(h.current, baseline)
  })

  test('an unconfigured suite leaves the guard inert', ({ assert }) => {
    const warns: string[] = []
    const sets: object[] = []
    const guard = createConfigBaselineGuard<object>({
      getConfig: () => {
        throw new Error('not configured')
      },
      setConfig: (c) => sets.push(c),
      warn: (m) => warns.push(m),
    })
    guard.onGroupStart() // baseline stays undefined (the throw is caught)
    assert.isFalse(guard.onGroupEnd('whatever'))
    assert.lengthOf(warns, 0)
    assert.lengthOf(sets, 0)
  })
})
