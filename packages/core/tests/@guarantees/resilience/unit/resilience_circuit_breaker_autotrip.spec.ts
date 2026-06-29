import { test } from '@japa/runner'
import CircuitBreakerService from '../../../../src/services/circuit_breaker_service.js'
import { setupTestConfig } from '../../../helpers/config.js'

/**
 * WS-2 / circuit-breaker-never-auto-trips.
 *
 * The breaker was only ever READ (`isOpen`) and never FIRED, so it could never
 * accumulate failures and never open — dead code dressed as resilience. The fix
 * adds `run()`, which fires the connectivity probe through the breaker, and the
 * request middlewares call it. These tests prove the breaker now auto-trips and
 * then fast-fails, using the `buildProbe` seam to force the probe outcome
 * without a live database.
 *
 * RED (pre-fix): no `run()` exists; firing was never wired, so the breaker
 * stayed CLOSED forever regardless of probe outcome.
 */
class ProbeControlledService extends CircuitBreakerService {
  fail = true
  protected buildProbe(): () => Promise<void> {
    return async () => {
      if (this.fail) throw new Error('tenant db down')
    }
  }
}

test.group('CircuitBreakerService.run() — auto-trip', (group) => {
  group.each.setup(() => setupTestConfig())

  test('repeated probe failures trip the breaker, then it fast-fails', async ({ assert }) => {
    const svc = new ProbeControlledService()
    const id = 'auto-trip-tenant'
    assert.isFalse(svc.isOpen(id))

    // Fire enough failing probes to clear volumeThreshold (5) at 100% error.
    for (let i = 0; i < 10; i++) {
      await svc.run(id).catch(() => {})
    }

    assert.isTrue(svc.isOpen(id), 'breaker must auto-open after repeated probe failures')
    assert.equal(svc.getMetrics(id)!.state, 'OPEN')

    // A subsequent call fast-fails with opossum's EOPENBREAKER (probe skipped).
    const err = await svc
      .run(id)
      .then(() => null)
      .catch((e) => e)
    assert.isNotNull(err)
    assert.isTrue(svc.isOpenRejection(err), 'an OPEN breaker must reject with EOPENBREAKER')

    await svc.destroy(id)
  })

  test('run() resolves and keeps the breaker CLOSED while the probe succeeds', async ({
    assert,
  }) => {
    const svc = new ProbeControlledService()
    svc.fail = false
    const id = 'healthy-tenant'
    await assert.doesNotReject(() => svc.run(id))
    assert.isFalse(svc.isOpen(id))
    assert.equal(svc.getMetrics(id)!.state, 'CLOSED')
    await svc.destroy(id)
  })

  test('isOpenRejection only matches the EOPENBREAKER fast-fail', ({ assert }) => {
    const svc = new ProbeControlledService()
    assert.isTrue(svc.isOpenRejection({ code: 'EOPENBREAKER' }))
    assert.isFalse(svc.isOpenRejection(new Error('some db error')))
    assert.isFalse(svc.isOpenRejection(undefined))
  })
})
