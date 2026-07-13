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
 * `guard.tenant_identifier` emit, and BOTH refusal paths route through it. The
 * throwing `assertSafeIdentifier` is pinned by the emission matrix; this spec
 * pins the non-throwing degrade twin `guardedSafeIdentifier` used at attribution
 * seams (rate-limit buckets, metric keys). Before TS-2 that path dropped a
 * forged id with NO audit trail — the asymmetry this closes.
 */

const UUID = '11111111-1111-4111-8111-111111111111'
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test.group('guardedSafeIdentifier — audited degrade', (group) => {
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

  test('a safe id returns true and emits nothing', async ({ assert }) => {
    assert.isTrue(guardedSafeIdentifier(UUID, 'tenant id'))
    assert.isTrue(guardedSafeIdentifier('acme-42', 'tenant id'))
    await settle()
    assert.lengthOf(captured, 0)
    assert.lengthOf(snapshotIsthmusCounters().rejected, 0)
  })

  test('a present-but-unsafe id returns false and emits guard.tenant_identifier once', async ({
    assert,
  }) => {
    // A ':' would inject key structure into a Redis bucket/metric key and forge
    // another tenant's attribution — exactly what a custom resolver could mint.
    assert.isFalse(guardedSafeIdentifier('victim:2026:requests', 'metric tenant id'))
    await settle()

    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.id, 'guard.tenant_identifier')
    assert.equal(captured[0]!.event, 'isthmus:guard:identifier:rejected')
    assert.equal(captured[0]!.severity, 'high')
    // The payload carries the seam's kind and a truncated copy of the value.
    assert.equal(captured[0]!.metadata.kind, 'metric tenant id')
    for (const value of Object.values(captured[0]!.metadata)) {
      if (typeof value === 'string') assert.isAtMost(value.length, 64)
    }
    assert.equal(
      snapshotIsthmusCounters().rejected.find((r) => r.id === 'guard.tenant_identifier')?.value ??
        0,
      1
    )
  })

  test('an ABSENT id degrades silently — undefined, null, and empty do not emit', async ({
    assert,
  }) => {
    // The ordinary "no tenant on this route" degrade to the shared bucket. If it
    // emitted, every untenanted request would trip the guard and drown the audit.
    assert.isFalse(guardedSafeIdentifier(undefined, 'tenant id'))
    assert.isFalse(guardedSafeIdentifier(null, 'tenant id'))
    assert.isFalse(guardedSafeIdentifier('', 'tenant id'))
    await settle()
    assert.lengthOf(captured, 0)
    assert.lengthOf(snapshotIsthmusCounters().rejected, 0)
  })

  test('both refusal paths route through the one emit (throw + degrade agree)', async ({
    assert,
  }) => {
    // The throwing guard emits before it throws...
    assert.throws(
      () => assertSafeIdentifier('bad:id', 'tenant id'),
      /Refusing to use unsafe tenant id/
    )
    // ...and the degrade twin emits the same event without throwing.
    assert.isFalse(guardedSafeIdentifier('bad:id', 'tenant id'))
    await settle()

    assert.lengthOf(captured, 2)
    assert.deepEqual(
      captured.map((c) => c.id),
      ['guard.tenant_identifier', 'guard.tenant_identifier']
    )
    assert.equal(
      snapshotIsthmusCounters().rejected.find((r) => r.id === 'guard.tenant_identifier')?.value ??
        0,
      2
    )
  })
})
