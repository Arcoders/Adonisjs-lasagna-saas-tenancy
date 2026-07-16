import { test } from '@japa/runner'
import {
  assertSafeIdentifier,
  guardedSafeIdentifier,
} from '../../../../src/isthmus/guarded_identifier.js'
import {
  snapshotIsthmusCounters,
  __resetIsthmusCounters,
  __resetIsthmusRateLimit,
  __setIsthmusDispatcherForTests,
} from '../../../../src/isthmus/audit.js'
import type { IsthmusGuardTrippedPayload } from '../../../../src/types/isthmus.js'

/**
 * TS-2: `isthmus/guarded_identifier.ts` is the single owner of the
 * `guard.tenant_identifier` emit, and the two refusal paths record on the
 * surface their stakes call for. The throwing `assertSafeIdentifier` (a near-miss
 * DDL/key injection) bumps the counter AND broadcasts the event — pinned by the
 * emission matrix. The non-throwing `guardedSafeIdentifier` (a dropped
 * attribution at rate-limit/metric seams) bumps the counter but broadcasts NO
 * event (`dispatch: false`): a forged id is still visible on the Prometheus
 * counter, yet a high-volume degrade can never consume the `high` dispatch budget
 * and crowd out a co-severity security guard's events. This spec pins that split.
 */

const UUID = '11111111-1111-4111-8111-111111111111'
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function rejectedOf(id: string): number {
  return snapshotIsthmusCounters().rejected.find((r) => r.id === id)?.value ?? 0
}

test.group('guardedSafeIdentifier — audited degrade (counter, no event)', (group) => {
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

  test('a safe id returns true and records nothing', async ({ assert }) => {
    assert.isTrue(guardedSafeIdentifier(UUID, 'tenant id'))
    assert.isTrue(guardedSafeIdentifier('acme-42', 'tenant id'))
    await settle()
    assert.lengthOf(captured, 0)
    assert.lengthOf(snapshotIsthmusCounters().rejected, 0)
  })

  test('a present-but-unsafe id returns false, bumps the counter, and dispatches NO event', async ({
    assert,
  }) => {
    // A ':' would inject key structure into a Redis bucket/metric key and forge
    // another tenant's attribution — exactly what a lax custom resolver could mint.
    assert.isFalse(guardedSafeIdentifier('victim:2026:requests', 'metric tenant id'))
    await settle()

    // The counter (the primary trip surface) records the forged id...
    assert.equal(rejectedOf('guard.tenant_identifier'), 1)
    // ...but the high-volume degrade broadcasts no event, so it consumes no
    // dispatch budget and cannot crowd out a co-severity security guard's events.
    assert.lengthOf(captured, 0)
  })

  test('an ABSENT id degrades silently — undefined, null, and empty record nothing', async ({
    assert,
  }) => {
    // The ordinary "no tenant on this route" degrade to the shared bucket. If it
    // recorded, every untenanted request would trip the guard and drown the audit.
    assert.isFalse(guardedSafeIdentifier(undefined, 'tenant id'))
    assert.isFalse(guardedSafeIdentifier(null, 'tenant id'))
    assert.isFalse(guardedSafeIdentifier('', 'tenant id'))
    await settle()
    assert.lengthOf(captured, 0)
    assert.lengthOf(snapshotIsthmusCounters().rejected, 0)
  })

  test('the two paths agree on the counter; only the throw broadcasts an event', async ({
    assert,
  }) => {
    // The throwing guard (a near-miss injection) bumps the counter AND events...
    assert.throws(
      () => assertSafeIdentifier('bad:id', 'tenant id'),
      /Refusing to use unsafe tenant id/
    )
    // ...the degrade (a dropped attribution) bumps the same counter, no event.
    assert.isFalse(guardedSafeIdentifier('bad:id', 'tenant id'))
    await settle()

    // Both refusals landed on the counter.
    assert.equal(rejectedOf('guard.tenant_identifier'), 2)
    // Only the throw was broadcast as an event.
    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.id, 'guard.tenant_identifier')
    assert.equal(captured[0]!.event, 'isthmus:guard:identifier:rejected')
    assert.equal(captured[0]!.severity, 'high')
  })
})
