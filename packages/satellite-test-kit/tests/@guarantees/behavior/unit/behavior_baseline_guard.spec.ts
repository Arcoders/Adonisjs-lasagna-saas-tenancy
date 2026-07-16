import { test } from '@japa/runner'
import { createBaselineGuards, type Baseline } from '../../../../src/baseline_guard.js'

/**
 * Chaos test for the generic integration-suite isolation backstop. It injects
 * state chaos (a leaked mutation a spec failed to restore) and proves the guard
 * detects it, names the group, and restores the boot baseline so the next spec is
 * not poisoned. Covers both an identity baseline (the config) and a value-equality
 * baseline (an array, like the resolver chain). The no-leak path must stay a
 * silent no-op so a well-behaved spec can never trip a false positive.
 */
function identityBaseline(box: { value: object }): Baseline<unknown> {
  return {
    name: 'config',
    capture: () => box.value,
    equals: (a, b) => Object.is(a, b),
    restore: (baseline) => {
      box.value = baseline as object
    },
  }
}

function arrayBaseline(box: { value: string[] }): Baseline<unknown> {
  return {
    name: 'resolver chain',
    capture: () => [...box.value],
    equals: (a, b) =>
      (a as string[]).length === (b as string[]).length &&
      (a as string[]).every((x, i) => x === (b as string[])[i]),
    restore: (baseline) => {
      box.value = [...(baseline as string[])]
    },
  }
}

test.group('baseline guard (generic)', () => {
  test('a no-leak group is a silent no-op for every baseline', ({ assert }) => {
    const cfg = { value: { a: 1 } }
    const chain = { value: ['header'] }
    const warns: string[] = []
    const guard = createBaselineGuards([identityBaseline(cfg), arrayBaseline(chain)], (m) =>
      warns.push(m)
    )
    guard.onGroupStart()
    assert.isFalse(guard.onGroupEnd('clean-group'))
    assert.lengthOf(warns, 0)
  })

  test('a leaked identity swap is detected, named, and restored', ({ assert }) => {
    const baseline = { a: 1 }
    const cfg = { value: baseline }
    const warns: string[] = []
    const guard = createBaselineGuards([identityBaseline(cfg)], (m) => warns.push(m))
    guard.onGroupStart()
    cfg.value = { a: 999 } // a spec swapped the config and never restored it
    assert.isTrue(guard.onGroupEnd('leaky-group'))
    assert.lengthOf(warns, 1)
    assert.match(warns[0], /leaky-group/)
    assert.match(warns[0], /config/)
    assert.strictEqual(cfg.value, baseline) // restored by identity to the boot baseline
  })

  test('a leaked array mutation is detected by value and restored', ({ assert }) => {
    const chain = { value: ['header'] }
    const warns: string[] = []
    const guard = createBaselineGuards([arrayBaseline(chain)], (m) => warns.push(m))
    guard.onGroupStart()
    chain.value = ['subdomain'] // a spec rewired the resolver chain and never restored it
    assert.isTrue(guard.onGroupEnd('leaky-group'))
    assert.deepEqual(chain.value, ['header'])
    assert.match(warns[0], /resolver chain/)
  })

  test('it snapshots once: a later group keeps the original baseline', ({ assert }) => {
    const baseline = { a: 1 }
    const cfg = { value: baseline }
    const guard = createBaselineGuards([identityBaseline(cfg)], () => {})
    guard.onGroupStart()
    cfg.value = { a: 2 }
    guard.onGroupEnd('g1')
    assert.strictEqual(cfg.value, baseline)
    // A second group must NOT re-baseline off a (hypothetically) drifted value.
    guard.onGroupStart()
    cfg.value = { a: 3 }
    guard.onGroupEnd('g2')
    assert.strictEqual(cfg.value, baseline)
  })

  test('a baseline whose capture always throws stays inert (never snapshotted)', ({ assert }) => {
    const warns: string[] = []
    const restores: unknown[] = []
    const guard = createBaselineGuards(
      [
        {
          name: 'unconfigured',
          capture: () => {
            throw new Error('not configured')
          },
          equals: () => false,
          restore: (b) => restores.push(b),
        },
      ],
      (m) => warns.push(m)
    )
    guard.onGroupStart() // capture throws -> not snapshotted
    assert.isFalse(guard.onGroupEnd('whatever')) // snapshot undefined -> skipped
    assert.lengthOf(warns, 0)
    assert.lengthOf(restores, 0)
  })

  test('a baseline that throws only at group-end is skipped that round', ({ assert }) => {
    let ready = true
    const warns: string[] = []
    const guard = createBaselineGuards(
      [
        {
          name: 'flaky',
          capture: () => {
            if (!ready) throw new Error('gone')
            return 'snap'
          },
          equals: (a, b) => a === b,
          restore: () => {},
        },
      ],
      (m) => warns.push(m)
    )
    guard.onGroupStart() // captures 'snap'
    ready = false // now capture throws at end
    assert.isFalse(guard.onGroupEnd('g')) // caught -> skipped, no warn
    assert.lengthOf(warns, 0)
  })
})
