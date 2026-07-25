import { test } from '@japa/runner'
import {
  ISTHMUS_BUDGETS,
  emitIsthmusEvent,
  snapshotIsthmusCounters,
  __resetIsthmusCounters,
  __resetIsthmusRateLimit,
  __setIsthmusDispatcherForTests,
} from '../../../../src/isthmus/audit.js'
import type { IsthmusGuardTrippedPayload } from '../../../../src/types/isthmus.js'

/**
 * S3 — cross-tenant alarm suppression via dispatch-budget amplification.
 *
 * The per-severity dispatch windows are shared across tenants (keyed by severity
 * only, on purpose — per-tenant sub-budgets would let an attacker with many ids
 * grow the window map without bound). So a guard that is attacker-reachable at
 * HIGH VOLUME must not broadcast, or a flood of it would exhaust its severity's
 * shared window and starve a co-severity security guard's alerts for OTHER
 * tenants. `guard.tenant_identifier` is classified `dispatchPolicy: 'count-only'`
 * to close that: it records on the counters but consumes no dispatch window.
 *
 * The negative self-test floods a BROADCAST high guard instead and shows the
 * shared window really can be exhausted, so the guarantee test is not a no-op.
 */

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function droppedRateLimited(severity: string): number {
  return snapshotIsthmusCounters()
    .dropped.filter((d) => d.severity === severity && d.reason === 'rate_limited')
    .reduce((sum, d) => sum + d.value, 0)
}

test.group('Isthmus dispatch starvation (S3)', (group) => {
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

  test('flooding the count-only identifier guard does NOT starve a concurrent high dispatch', async ({
    assert,
  }) => {
    // Attacker floods the request-reachable, HIGH-severity identifier guard well
    // past the `high` window budget. It is count-only, so it broadcasts nothing
    // and consumes NONE of the shared `high` window.
    const flood = ISTHMUS_BUDGETS.high + 50
    for (let i = 0; i < flood; i++) {
      emitIsthmusEvent('guard.tenant_identifier', {
        tenantId: UUID_A,
        metadata: { kind: 'attack', value: `x${i}` },
      })
    }

    // A genuine, co-severity (high) security guard trips for ANOTHER tenant.
    emitIsthmusEvent('guard.webhook_url', { tenantId: UUID_B, metadata: { reason: 'ssrf' } })
    await settle()

    // Its alert survives: the count-only flood consumed no dispatch budget.
    assert.isTrue(
      captured.some((p) => p.id === 'guard.webhook_url'),
      'the concurrent high-severity alert must still dispatch'
    )
    // The flood recorded on the counter (the signal is not lost)...
    assert.equal(
      snapshotIsthmusCounters().rejected.find((r) => r.id === 'guard.tenant_identifier')?.value,
      flood
    )
    // ...and broadcast nothing itself.
    assert.isFalse(captured.some((p) => p.id === 'guard.tenant_identifier'))
  })

  test('negative self-test: flooding a BROADCAST high guard DOES exhaust the shared window', async ({
    assert,
  }) => {
    // Same flood volume, but with a guard that broadcasts (redirect_host, high).
    // After the budget is spent, a different high guard is dropped: the shared
    // window is genuinely exhaustible, so the guarantee test above is meaningful.
    const flood = ISTHMUS_BUDGETS.high + 50
    for (let i = 0; i < flood; i++) {
      emitIsthmusEvent('guard.redirect_host', { tenantId: UUID_A, metadata: { reason: `r${i}` } })
    }

    emitIsthmusEvent('guard.webhook_url', { tenantId: UUID_B, metadata: { reason: 'ssrf' } })
    await settle()

    assert.isFalse(
      captured.some((p) => p.id === 'guard.webhook_url'),
      'the concurrent alert is starved once the shared window is exhausted'
    )
    assert.isAbove(
      droppedRateLimited('high'),
      0,
      'the exhaustion is recorded as rate-limited drops'
    )
  })
})
