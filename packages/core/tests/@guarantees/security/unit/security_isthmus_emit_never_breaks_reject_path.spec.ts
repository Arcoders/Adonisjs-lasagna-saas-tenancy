import { test } from '@japa/runner'
import {
  ISTHMUS_BUDGETS,
  emitIsthmusEvent,
  snapshotIsthmusCounters,
  __resetIsthmusCounters,
  __resetIsthmusRateLimit,
  __setIsthmusDispatcherForTests,
} from '../../../../src/isthmus/audit.js'
import { isthmusEntry } from '../../../../src/isthmus/registry.js'
import { assertMetricValue } from '../../../../src/services/metrics_validation.js'
import { assertConfigBounds } from '../../../../src/providers/assert_config_bounds.js'
import { testConfig } from '../../../helpers/config.js'
import type { IsthmusGuardTrippedPayload } from '../../../../src/types/isthmus.js'

/**
 * The emit helper's contract (cross-cutting invariants 1-3 of the Isthmus):
 * counters first and always; everything dropped is counted; and the reject
 * path can never be blocked, broken, or masked by the audit path — including
 * in an unbooted process (unit runners, config-phase guards before the app
 * provider wires the emitter).
 */

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function dropped(reason: string): number {
  return snapshotIsthmusCounters()
    .dropped.filter((d) => d.reason === reason)
    .reduce((sum, d) => sum + d.value, 0)
}

test.group('Isthmus emit — never breaks the reject path', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []

  group.each.setup(() => {
    captured = []
    __resetIsthmusCounters()
    __resetIsthmusRateLimit()
    __setIsthmusDispatcherForTests(async (payload) => {
      captured.push(payload)
    })
  })

  group.each.teardown(() => {
    __setIsthmusDispatcherForTests(undefined)
    __resetIsthmusCounters()
    __resetIsthmusRateLimit()
  })

  test('the dispatched payload mirrors the registry entry plus trip-site context', async ({
    assert,
  }) => {
    const entry = isthmusEntry('guard.metric_value')
    emitIsthmusEvent('guard.metric_value', {
      tenantId: '11111111-1111-4111-8111-111111111111',
      metadata: { value: '1.5' },
    })
    await settle()

    assert.lengthOf(captured, 1)
    assert.deepEqual(captured[0], {
      id: entry.id,
      pillar: entry.pillar,
      bugClass: entry.bugClass,
      severity: entry.severity,
      event: entry.event,
      tenantId: '11111111-1111-4111-8111-111111111111',
      metadata: { value: '1.5' },
    })
  })

  test('counters bump and the guard exception still propagates when the dispatcher throws', async ({
    assert,
  }) => {
    __setIsthmusDispatcherForTests(async () => {
      throw new Error('listener exploded')
    })

    assert.throws(() => assertMetricValue(1.5), /Refusing to record metric value/)
    await settle()

    const snapshot = snapshotIsthmusCounters()
    const rejected = snapshot.rejected.find((r) => r.id === 'guard.metric_value')
    assert.equal(rejected?.value, 1, 'the rejected counter must bump despite the dispatch failure')
    assert.equal(dropped('no_emitter'), 1, 'the failed dispatch must be counted, never rethrown')
  })

  test('an unbooted process (default dispatcher, no emitter) drops with no_emitter and never throws', async ({
    assert,
  }) => {
    __setIsthmusDispatcherForTests(undefined)

    // No Ignitor in this process: BaseEvent has no emitter wired, so the real
    // dispatch path must swallow the RuntimeException and count the drop.
    emitIsthmusEvent('guard.metric_value')
    await settle()

    assert.equal(dropped('no_emitter'), 1)
    const guarded = snapshotIsthmusCounters().guarded
    assert.isTrue(
      guarded.some((g) => g.value > 0),
      'counters must bump even when no emitter exists'
    )
  })

  test('a config-phase guard trips pre-boot: original exception, counters, silent audit path', async ({
    assert,
  }) => {
    assert.throws(
      () => assertConfigBounds({ ...testConfig, circuitBreaker: { threshold: 0 } } as any),
      /multitenancy\.circuitBreaker\.threshold must be/
    )
    await settle()

    const rejected = snapshotIsthmusCounters().rejected.find((r) => r.id === 'guard.config_bounds')
    assert.equal(rejected?.value, 1)
    assert.lengthOf(captured, 1, 'the config-phase trip still dispatches through the seam')
    assert.equal(captured[0]!.id, 'guard.config_bounds')
  })

  test('beyond the severity budget, dispatch drops as rate_limited but totals stay exact', async ({
    assert,
  }) => {
    const entry = isthmusEntry('guard.metric_value')
    const budget = ISTHMUS_BUDGETS[entry.severity]
    const extra = 7

    for (let i = 0; i < budget + extra; i++) {
      emitIsthmusEvent('guard.metric_value')
    }
    await settle()

    assert.lengthOf(captured, budget, 'dispatches are capped at the severity budget')
    assert.equal(dropped('rate_limited'), extra, 'every suppressed dispatch is counted')
    const rejected = snapshotIsthmusCounters().rejected.find((r) => r.id === 'guard.metric_value')
    assert.equal(rejected?.value, budget + extra, 'the trip counter is never rate-limited')
  })
})
