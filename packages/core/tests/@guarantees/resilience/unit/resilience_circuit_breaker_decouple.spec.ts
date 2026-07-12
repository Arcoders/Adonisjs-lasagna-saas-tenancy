import { test } from '@japa/runner'
import CircuitBreakerService from '../../../../src/services/circuit_breaker_service.js'
import { setupTestConfig } from '../../../helpers/config.js'
import { getConfig, setConfig } from '../../../../src/config.js'

/**
 * F3: the breaker's fail-fast decision is DECOUPLED from the heavy opossum
 * object via a lightweight `markers` map, so under memory pressure (a fleet-wide
 * outage that opens every tenant) the heavy OPEN breaker can be evicted while the
 * tenant keeps failing fast — and self-heals once the window elapses.
 *
 * These use a controllable clock + probe (and no Redis) so the marker lifecycle
 * is deterministic, independent of opossum's real timers.
 */
class DecoupleTestService extends CircuitBreakerService {
  clock = 1_000_000
  probeFails = false

  advance(ms: number): void {
    this.clock += ms
  }

  protected now(): number {
    return this.clock
  }

  protected buildProbe(): () => Promise<void> {
    return async () => {
      if (this.probeFails) throw new Error('tenant db down')
    }
  }

  get trackedCount(): number {
    return (this as any).circuits.size
  }

  get markerCount(): number {
    return (this as any).markers.size
  }
}

function capCircuitsAt(max: number): void {
  const cfg = getConfig()
  setConfig({
    ...cfg,
    circuitBreaker: { ...cfg.circuitBreaker, maxTrackedCircuits: max, resetTimeout: 30_000 },
  })
}

test.group('CircuitBreakerService — fail-fast decouple (F3)', (group) => {
  group.each.setup(() => setupTestConfig())

  test('an OPEN breaker can be evicted and the tenant still fast-fails from its marker', ({
    assert,
  }) => {
    capCircuitsAt(1)
    const svc = new DecoupleTestService()

    svc.getCircuit('A').open()
    assert.isTrue(svc.isOpen('A'))
    assert.equal(svc.trackedCount, 1)
    assert.equal(svc.markerCount, 1)

    // Creating a second breaker at cap=1 evicts the heavy OPEN breaker A, but its
    // marker is preserved so fast-fail survives.
    svc.getCircuit('B')
    assert.equal(svc.trackedCount, 1, 'the breaker map stays bounded at the cap')
    assert.isNull(svc.getMetrics('A'), 'the heavy opossum object for A was shed')
    assert.isTrue(svc.isOpen('A'), 'but A still reports OPEN from its lightweight marker')
  })

  test('run() fast-fails from the marker without materializing a heavy breaker', async ({
    assert,
  }) => {
    capCircuitsAt(1)
    const svc = new DecoupleTestService()

    svc.getCircuit('A').open()
    svc.getCircuit('B') // evicts A, keeps marker
    assert.isNull(svc.getMetrics('A'))

    const err = await svc
      .run('A')
      .then(() => null)
      .catch((e) => e)
    assert.isNotNull(err)
    assert.isTrue(svc.isOpenRejection(err), 'the marker fast-fail mirrors EOPENBREAKER')
    assert.isNull(svc.getMetrics('A'), 'no heavy breaker was recreated just to fast-fail')
  })

  test('once the window elapses, run() recreates the breaker and lets a probe through', async ({
    assert,
  }) => {
    capCircuitsAt(1)
    const svc = new DecoupleTestService()

    svc.getCircuit('A').open()
    svc.getCircuit('B') // evicts A
    assert.isTrue(svc.isOpen('A'))

    // Past the marker window: the tenant would be HALF_OPEN, so run() recreates a
    // fresh CLOSED breaker and lets the (healthy) probe through — it stays CLOSED.
    svc.probeFails = false
    svc.advance(30_001)
    assert.isFalse(svc.isOpen('A'), 'the elapsed marker no longer forces OPEN')

    await assert.doesNotReject(() => svc.run('A'))
    assert.equal(svc.getMetrics('A')!.state, 'CLOSED', 'a fresh breaker was recreated and probed')
    assert.equal(svc.markerCount, 0, 'the stale marker was cleared')
  })

  test('a failing probe after the window re-arms the fast-fail marker', async ({ assert }) => {
    capCircuitsAt(5_000)
    // Tight tuning so a single failing probe trips OPEN.
    const cfg = getConfig()
    setConfig({
      ...cfg,
      circuitBreaker: {
        ...cfg.circuitBreaker,
        threshold: 1,
        volumeThreshold: 1,
        resetTimeout: 30_000,
      },
    })
    const svc = new DecoupleTestService()
    svc.probeFails = true

    for (let i = 0; i < 5; i++) {
      await svc.run('A').catch(() => {})
      if (svc.isOpen('A')) break
    }
    assert.isTrue(svc.isOpen('A'), 'repeated probe failures trip the breaker and set the marker')
    assert.equal(svc.markerCount, 1)
  })

  test('open sets a marker; reset and destroy clear it', async ({ assert }) => {
    const svc = new DecoupleTestService()

    svc.getCircuit('A')
    assert.equal(svc.markerCount, 0)

    svc.getCircuit('A').open()
    assert.equal(svc.markerCount, 1)
    assert.isTrue(svc.isOpen('A'))

    svc.reset('A')
    assert.equal(svc.markerCount, 0, 'reset clears the marker')
    assert.isFalse(svc.isOpen('A'))

    svc.getCircuit('A').open()
    assert.equal(svc.markerCount, 1)
    await svc.destroy('A')
    assert.equal(svc.markerCount, 0, 'destroy clears the marker')
    assert.isFalse(svc.isOpen('A'))
  })
})
