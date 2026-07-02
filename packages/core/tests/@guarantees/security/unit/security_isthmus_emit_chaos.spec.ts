import { test } from '@japa/runner'
import {
  ISTHMUS_BUDGETS,
  allowIsthmusEvent,
  emitIsthmusEvent,
  snapshotIsthmusCounters,
  __resetIsthmusCounters,
  __resetIsthmusRateLimit,
  __setIsthmusDispatcherForTests,
} from '../../../../src/isthmus/audit.js'
import type { IsthmusGuardId } from '../../../../src/isthmus/registry.js'
import type { IsthmusGuardTrippedPayload, IsthmusSeverity } from '../../../../src/types/isthmus.js'

/**
 * Chaos cases for the emit helper: hostile dispatchers, hostile clocks, hostile
 * callers. The three cross-cutting invariants must hold under ALL of them:
 * counters first and always, everything dropped is counted, and the reject path
 * can never be blocked, broken, or masked by the audit path.
 */

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function dropped(reason: string): number {
  return snapshotIsthmusCounters()
    .dropped.filter((d) => d.reason === reason)
    .reduce((sum, d) => sum + d.value, 0)
}

function rejectedOf(id: IsthmusGuardId): number {
  return snapshotIsthmusCounters().rejected.find((r) => r.id === id)?.value ?? 0
}

test.group('Isthmus emit — chaos', (group) => {
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

  test('a SYNC-throwing dispatcher never breaks the caller AND the drop is counted', async ({
    assert,
  }) => {
    // A non-async function that throws before ever returning a promise. The
    // seam's type says Promise<void>, but the audit path's contract must hold
    // even for a misbehaving implementation: swallow AND count.
    __setIsthmusDispatcherForTests((() => {
      throw new Error('sync boom')
    }) as unknown as (payload: IsthmusGuardTrippedPayload) => Promise<void>)

    assert.doesNotThrow(() => emitIsthmusEvent('guard.metric_value'))
    await settle()

    assert.equal(rejectedOf('guard.metric_value'), 1, 'counters must bump before dispatch')
    assert.equal(dropped('no_emitter'), 1, 'a sync dispatcher throw is still a counted drop')
  })

  test('a hanging dispatcher (never settles) does not block emit or subsequent emits', async ({
    assert,
  }) => {
    __setIsthmusDispatcherForTests(() => new Promise<void>(() => {}))

    let returned = false
    emitIsthmusEvent('guard.metric_value')
    returned = true
    assert.isTrue(returned, 'emitIsthmusEvent must return synchronously')

    // Subsequent emits keep working, unaffected by the pending promise.
    __setIsthmusDispatcherForTests(async (payload) => {
      captured.push(payload)
    })
    emitIsthmusEvent('guard.metric_value')
    await settle()

    assert.lengthOf(captured, 1)
    assert.equal(rejectedOf('guard.metric_value'), 2)
  })

  test('a runtime-invalid id never throws and mutates no counter', async ({ assert }) => {
    assert.doesNotThrow(() => emitIsthmusEvent('guard.does_not_exist' as IsthmusGuardId))
    await settle()

    const snapshot = snapshotIsthmusCounters()
    assert.lengthOf(snapshot.guarded, 0)
    assert.lengthOf(snapshot.rejected, 0)
    assert.lengthOf(snapshot.dropped, 0)
    assert.lengthOf(captured, 0)
  })

  test('a clock that goes backwards does not crash and the budget still holds', ({ assert }) => {
    const t0 = 1_000_000
    assert.isTrue(allowIsthmusEvent('info', t0))
    // Time goes backwards: the surviving window keeps counting.
    let allowed = 1
    for (let i = 0; i < ISTHMUS_BUDGETS.info + 10; i++) {
      if (allowIsthmusEvent('info', t0 - 5_000)) allowed++
    }
    assert.equal(allowed, ISTHMUS_BUDGETS.info, 'the budget is enforced even under skew')
  })

  test('exactly WINDOW_MS after the window start opens a fresh budget (>= semantics)', ({
    assert,
  }) => {
    const t0 = 1_000_000
    for (let i = 0; i < ISTHMUS_BUDGETS.warn; i++) {
      allowIsthmusEvent('warn', t0)
    }
    assert.isFalse(allowIsthmusEvent('warn', t0 + 9_999))
    assert.isTrue(allowIsthmusEvent('warn', t0 + 10_000), 'the boundary itself resets the window')
  })

  test('mutating a returned snapshot does not affect the internals (regression pin)', ({
    assert,
  }) => {
    // Vacuously green today (the snapshot builds fresh arrays per call); pinned
    // so a refactor to returning internal references fails here, not in prod.
    emitIsthmusEvent('guard.metric_value')
    const first = snapshotIsthmusCounters()
    ;(first.rejected as Array<{ value: number }>).push({ value: 999 })
    ;(first.rejected[0] as { value: number }).value = 999

    const second = snapshotIsthmusCounters()
    assert.lengthOf(second.rejected, 1)
    assert.equal(second.rejected[0].value, 1)
  })

  test('conservation law: dispatched + rate-limited drops === guard trips, per severity', async ({
    assert,
  }) => {
    // One guard id per severity so the roll-up key maps 1:1.
    const BY_SEVERITY: Record<IsthmusSeverity, IsthmusGuardId> = {
      critical: 'seal.tenant_context',
      high: 'guard.tenant_identifier',
      warn: 'guard.metric_value',
      info: 'audit.scope_bypass',
    }
    const TRIPS_PER_SEVERITY = 260 // above every budget (max is critical's 200)

    // Fixed interleaved permutation (no randomness): rotate severities each step.
    const severities = Object.keys(BY_SEVERITY) as IsthmusSeverity[]
    for (let i = 0; i < TRIPS_PER_SEVERITY * severities.length; i++) {
      emitIsthmusEvent(BY_SEVERITY[severities[i % severities.length]])
    }
    await settle()

    const snapshot = snapshotIsthmusCounters()
    for (const severity of severities) {
      const guarded = snapshot.guarded
        .filter((g) => g.severity === severity)
        .reduce((sum, g) => sum + g.value, 0)
      const dispatched = captured.filter((p) => p.severity === severity).length
      const rateLimited = snapshot.dropped
        .filter((d) => d.severity === severity && d.reason === 'rate_limited')
        .reduce((sum, d) => sum + d.value, 0)

      assert.equal(guarded, TRIPS_PER_SEVERITY, `${severity}: every trip is counted`)
      // Window-boundary-proof: a slow run may open a second window (more
      // dispatches, fewer drops) but the conservation identity always holds.
      assert.equal(
        dispatched + rateLimited,
        guarded,
        `${severity}: dispatched (${dispatched}) + rate-limited (${rateLimited}) must equal trips`
      )
      assert.isAtLeast(dispatched, 1, `${severity}: at least one dispatch went through`)
    }
    const noEmitter = snapshot.dropped.filter((d) => d.reason === 'no_emitter')
    assert.lengthOf(noEmitter, 0, 'control: no dispatch failures in this run')
  })
})
