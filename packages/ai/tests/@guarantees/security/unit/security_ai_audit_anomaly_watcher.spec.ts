import { test } from '@japa/runner'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import AiAuditAnomalyWatcher, {
  reportScheduledVerify,
  wireAiAuditAnomalyWatcher,
  type GuardTrippedEventLike,
} from '../../../../src/services/ai_audit_anomaly_watcher.js'
import { MAX_AI_ANOMALY_TRACKED_KEYS } from '../../../../src/constants.js'
import {
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'

/**
 * Wave 4 acceptance (3.5/3.6): the audit alerting observers. The anomaly watcher fires
 * exactly once when guard-trip velocity crosses the threshold within the window, is
 * fail-open (a throwing delivery never reaches the tripping request), and bounds its key
 * map. reportScheduledVerify raises a found chain break to guard.ai_audit_chain_broken.
 */

const TRIP = { tenantId: 'tenant-1', principalHash: 'p', guard: 'guard.ai_scope_mismatch' }

test.group('AiAuditAnomalyWatcher (Wave 4, 3.6)', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []
  const metrics: string[] = []
  group.each.setup(() => {
    captured = []
    metrics.length = 0
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async (p) => {
      captured.push(p)
    })
  })
  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('fires exactly one guard.ai_anomaly + metric when the threshold is crossed', async ({
    assert,
  }) => {
    const watcher = new AiAuditAnomalyWatcher({
      threshold: 3,
      windowMs: 60_000,
      emitMetric: (_t, name) => {
        metrics.push(name)
      },
    })
    watcher.record(TRIP, 1_000)
    watcher.record(TRIP, 1_100)
    assert.lengthOf(captured, 0, 'below threshold: silent')
    watcher.record(TRIP, 1_200) // the 3rd within the window breaches
    await new Promise<void>((r) => setImmediate(r))

    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.id, 'guard.ai_anomaly')
    assert.equal(captured[0]!.severity, 'high')
    assert.equal(captured[0]!.tenantId, 'tenant-1')
    assert.deepEqual(metrics, ['ai_anomaly'])
  })

  test('a sliding window drops trips older than windowMs, so a slow drip never fires', async ({
    assert,
  }) => {
    const watcher = new AiAuditAnomalyWatcher({ threshold: 3, windowMs: 1_000 })
    watcher.record(TRIP, 0)
    watcher.record(TRIP, 2_000) // > window after the first: the first is pruned
    watcher.record(TRIP, 4_000) // only this + prior in-window count = 2 < 3
    await new Promise<void>((r) => setImmediate(r))
    assert.lengthOf(captured, 0)
  })

  test('delivers the summary to onAnomaly; a throwing hook is swallowed (fail-open)', async ({
    assert,
  }) => {
    const seen: Array<{ guard: string; count: number }> = []
    const okWatcher = new AiAuditAnomalyWatcher({
      threshold: 2,
      onAnomaly: (a) => {
        seen.push({ guard: a.guard, count: a.count })
      },
    })
    okWatcher.record(TRIP, 1)
    okWatcher.record(TRIP, 2)
    assert.deepEqual(seen, [{ guard: 'guard.ai_scope_mismatch', count: 2 }])

    const boomWatcher = new AiAuditAnomalyWatcher({
      threshold: 2,
      onAnomaly: () => {
        throw new Error('pager down')
      },
    })
    // record must NOT throw even though the delivery hook does.
    assert.doesNotThrow(() => {
      boomWatcher.record(TRIP, 1)
      boomWatcher.record(TRIP, 2)
    })
  })

  test('the key map is bounded at MAX_AI_ANOMALY_TRACKED_KEYS (an unbounded key space is a DoS)', ({
    assert,
  }) => {
    const watcher = new AiAuditAnomalyWatcher({ threshold: 1_000_000, windowMs: 1_000_000 })
    for (let i = 0; i < MAX_AI_ANOMALY_TRACKED_KEYS + 500; i++) {
      watcher.record({ tenantId: 't', principalHash: `p-${i}`, guard: 'guard.ai_rate_limited' }, 1)
    }
    assert.isAtMost(watcher.trackedKeys, MAX_AI_ANOMALY_TRACKED_KEYS)
  })
})

test.group('reportScheduledVerify (Wave 4, 3.5)', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []
  group.each.setup(() => {
    captured = []
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async (p) => {
      captured.push(p)
    })
  })
  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('a found break emits guard.ai_audit_chain_broken (critical); a clean result is silent', async ({
    assert,
  }) => {
    reportScheduledVerify({ ok: true, checked: 5 })
    await new Promise<void>((r) => setImmediate(r))
    assert.lengthOf(captured, 0)

    reportScheduledVerify({
      ok: false,
      checked: 2,
      break: { tenantId: 'tenant-1', seq: 3, reason: 'checksum' },
    })
    await new Promise<void>((r) => setImmediate(r))
    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.id, 'guard.ai_audit_chain_broken')
    assert.equal(captured[0]!.severity, 'critical')
    assert.deepEqual(captured[0]!.metadata, { seq: 3, reason: 'checksum' })
  })
})

test.group('wireAiAuditAnomalyWatcher (Wave 4, 3.6)', () => {
  test('records only guard.ai_* request trips, ignoring non-ai and its own alert signals', ({
    assert,
  }) => {
    const recorded: string[] = []
    const watcher = { record: (trip: { guard: string }) => recorded.push(trip.guard) }
    let handler: ((event: GuardTrippedEventLike) => void) | undefined
    const emitter = {
      on: (_e: unknown, h: (event: GuardTrippedEventLike) => void) => {
        handler = h
        return () => {}
      },
    }
    wireAiAuditAnomalyWatcher(emitter, {}, watcher as unknown as AiAuditAnomalyWatcher, () => 1_000)
    handler!({ payload: { id: 'guard.ai_scope_mismatch', tenantId: 't1', metadata: {} } })
    handler!({ payload: { id: 'guard.core_something', tenantId: 't1' } }) // not ai_*
    handler!({ payload: { id: 'guard.ai_anomaly', tenantId: 't1' } }) // its own signal
    handler!({ payload: { id: 'guard.ai_audit_chain_broken', tenantId: 't1' } }) // alert signal
    handler!({ payload: { id: 'guard.ai_rate_limited' } }) // no tenant
    assert.deepEqual(recorded, ['guard.ai_scope_mismatch'])
  })
})
