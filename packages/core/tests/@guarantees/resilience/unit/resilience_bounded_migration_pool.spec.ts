import { test } from '@japa/runner'
import { mapWithConcurrency } from '../../../../src/utils/concurrency.js'
import { resolveMigrationConcurrency } from '../../../../src/services/isolation/operational_budget.js'
import { setConfig } from '../../../../src/config.js'
import { __resetConfigForTests } from '../../../../src/testing/config_reset.js'
import { testConfig } from '../../../helpers/config.js'

/**
 * F1 — the bounded, cap-aware migration worker pool. The two testable units:
 *   - `mapWithConcurrency` bounds in-flight work, preserves result order, and
 *     leaves per-item failure isolation to the caller (the command catches so one
 *     tenant's failure never aborts the batch).
 *   - `resolveMigrationConcurrency` clamps a `--concurrency` request into
 *     `[1, operationalConnectionBudget]`, so a parallel run can never open more
 *     connections than the budget (and thus never breach the absolute ceiling).
 * The command wiring itself is exercised by the e2e suite (ace execution).
 */

test.group('mapWithConcurrency', () => {
  test('preserves result order regardless of completion order', async ({ assert }) => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 3, async (n) => {
      // Later items finish sooner, so order is only preserved by index, not timing.
      await new Promise((r) => setTimeout(r, (6 - n) * 3))
      return n * 10
    })
    assert.deepEqual(out, [10, 20, 30, 40, 50])
  })

  test('never runs more than `limit` items in flight', async ({ assert }) => {
    let active = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 30 }, (_, i) => i), 4, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 3))
      active--
    })
    assert.isAtMost(peak, 4, 'the pool never exceeds the concurrency limit')
  })

  test('per-item failure is the caller\'s to isolate; the batch still completes', async ({
    assert,
  }) => {
    const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      try {
        if (n === 2) throw new Error('boom')
        return { n, ok: true }
      } catch {
        return { n, ok: false }
      }
    })
    assert.deepEqual(
      out.map((o) => o.ok),
      [true, false, true],
      'a failing item does not abort its peers'
    )
  })

  test('a limit below 1 still runs (floored to a single worker)', async ({ assert }) => {
    const out = await mapWithConcurrency([1, 2], 0, async (n) => n)
    assert.deepEqual(out, [1, 2])
  })
})

test.group('resolveMigrationConcurrency clamps to the operational budget (F1 on S2)', (group) => {
  group.each.setup(() => __resetConfigForTests())
  group.each.teardown(() => __resetConfigForTests())

  function configure(iso: Record<string, unknown>): void {
    setConfig({ ...testConfig, isolation: { driver: 'schema-pg', ...iso } } as any)
  }

  test('omitted concurrency defaults to 1 (sequential, non-disruptive)', ({ assert }) => {
    configure({ operationalConnectionBudget: 8 })
    assert.equal(resolveMigrationConcurrency(undefined), 1)
  })

  test('a request is clamped into [1, budget]', ({ assert }) => {
    configure({ operationalConnectionBudget: 3 })
    assert.equal(resolveMigrationConcurrency(10), 3, 'clamped down to the budget')
    assert.equal(resolveMigrationConcurrency(2), 2, 'within budget passes through')
    assert.equal(resolveMigrationConcurrency(0), 1, 'floored at 1')
  })

  test('the budget is itself clamped to the absolute ceiling', ({ assert }) => {
    configure({ operationalConnectionBudget: 8, maxTenantConnectionsHardCeiling: 2 })
    assert.equal(resolveMigrationConcurrency(8), 2, 'never exceeds the ceiling')
  })
})
