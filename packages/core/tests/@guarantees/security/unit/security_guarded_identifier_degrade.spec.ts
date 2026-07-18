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
 * `guard.tenant_identifier` emit. Both refusal paths bump the `rejected` counter
 * (the kernel's primary trip surface): the throwing `assertSafeIdentifier` (a
 * near-miss DDL/key injection, whose throw is itself the real-time signal) and
 * the non-throwing `guardedSafeIdentifier` (a dropped attribution at
 * rate-limit/metric seams). NEITHER broadcasts the `IsthmusGuardTripped` event:
 * the guard is classified `dispatchPolicy: 'count-only'` (S3) because it is
 * attacker-reachable at volume, so a flood can never consume the `high` dispatch
 * window and crowd out a co-severity security guard's events for other tenants.
 * A forged id stays visible on the Prometheus counter. This spec pins that.
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
    // ...but the count-only guard broadcasts no event, so it consumes no dispatch
    // budget and cannot crowd out a co-severity security guard's events.
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

  test('both paths agree on the counter; neither broadcasts (count-only classification)', async ({
    assert,
  }) => {
    // The throwing guard (a near-miss injection) bumps the counter; the throw is
    // the real-time signal...
    assert.throws(
      () => assertSafeIdentifier('bad:id', 'tenant id'),
      /Refusing to use unsafe tenant id/
    )
    // ...the degrade (a dropped attribution) bumps the same counter.
    assert.isFalse(guardedSafeIdentifier('bad:id', 'tenant id'))
    await settle()

    // Both refusals landed on the counter.
    assert.equal(rejectedOf('guard.tenant_identifier'), 2)
    // Neither was broadcast: the guard is count-only, so it can never consume the
    // shared `high` dispatch window (S3).
    assert.lengthOf(captured, 0)
  })
})
