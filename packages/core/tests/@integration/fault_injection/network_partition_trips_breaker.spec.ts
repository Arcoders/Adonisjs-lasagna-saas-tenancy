import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'
import { testConfig } from '../../helpers/config.js'

/**
 * Fault injection: a tenant-DB network partition drives the circuit breaker
 * through its full state machine (CLOSED -> OPEN under partition, then
 * HALF_OPEN -> CLOSED after recovery) against the real booted app.
 *
 * This complements, rather than duplicates, the two existing breaker specs:
 *   - resilience_circuit_breaker_service_redis_down covers the breaker
 *     surviving a Redis (persistence) outage; it never asserts the auto-trip
 *     transitions.
 *   - resilience_pg_outage_mid_transaction covers the driver-error
 *     classification + rollback when a backend is severed; it does not touch the
 *     breaker at all.
 * The focus here is the opossum state machine on the connect-step probe:
 * `run()` fires the probe THROUGH the breaker (circuit_breaker_service.ts:206),
 * so repeated probe rejections accumulate failures until the breaker trips OPEN,
 * after which it fast-fails with `EOPENBREAKER` (probe skipped). After
 * `resetTimeout` opossum lets one trial probe through in HALF_OPEN; a success
 * there closes the breaker again (the 'halfOpen'/'close' listeners in
 * circuit_breaker_service.ts:121-131).
 *
 * Outage-simulation technique: we reuse the `buildProbe()` seam that the
 * autotrip unit spec uses, but here the probe runs a REAL `SELECT 1` against a
 * real connection when the link is up, and throws a realistic severed-connection
 * error (`ECONNRESET`, which `isDependencyOutageError` classifies as an outage)
 * while the partition is in effect. Toggling the flag simulates the dependency
 * coming back without tearing down a shared container, so the HALF_OPEN -> CLOSED
 * half of the machine stays deterministic in CI. This mirrors the existing specs'
 * "inject through the protected seam, never mutate a shared singleton" stance.
 *
 * Imports follow the @integration convention (the public `@adonisjs-lasagna/...`
 * subpaths, which resolve to the compiled ./build via the package exports map),
 * matching the sibling max_connections_exceeded spec, so this exercises the SAME
 * build the rest of the suite does. The test/config helpers stay relative.
 */
const TENANT = 'partition-breaker-tenant'

/**
 * Tight breaker tuning so the state machine is fast + deterministic under CI:
 * one in-volume failure at 100% error trips OPEN, and a 250ms resetTimeout keeps
 * the HALF_OPEN wait short. resetTimeout is the OPEN -> HALF_OPEN delay.
 */
function fastBreakerConfig(): MultitenancyConfig {
  return {
    ...testConfig,
    circuitBreaker: {
      threshold: 1,
      volumeThreshold: 1,
      resetTimeout: 250,
      rollingCountTimeout: 1000,
    },
  } as MultitenancyConfig
}

/**
 * A breaker whose probe models a switchable tenant-DB link: a real `SELECT 1`
 * when up, an `ECONNRESET`-coded rejection (a dependency outage) while
 * partitioned. The probe runs THROUGH opossum via `run()`, exactly as the
 * request middlewares fire it on the tenant connect step.
 */
class PartitionableBreaker extends CircuitBreakerService {
  public partitioned = false

  protected buildProbe(_tenantId: string): () => Promise<void> {
    return async () => {
      if (this.partitioned) {
        const err: NodeJS.ErrnoException = new Error(
          'read ECONNRESET (simulated tenant-DB partition)'
        )
        err.code = 'ECONNRESET'
        throw err
      }
      // Link is up: prove the probe path actually reaches a live backend.
      await db.connection('public').rawQuery('SELECT 1')
    }
  }
}

test.group('network partition trips the tenant circuit breaker (fault injection)', (group) => {
  let original: ReturnType<typeof getConfig>
  let svc: PartitionableBreaker

  group.each.setup(() => {
    // Snapshot + tighten the breaker config; restored in teardown so a leaked
    // setConfig can't poison sibling specs that share this one booted app.
    original = getConfig()
    setConfig(fastBreakerConfig())
    svc = new PartitionableBreaker()
  })

  group.each.teardown(async () => {
    await svc.destroy(TENANT).catch(() => {})
    setConfig(original)
  })

  test('partition trips the breaker OPEN within the threshold, then recovers to CLOSED', async ({
    assert,
  }) => {
    // Healthy to start: the real `SELECT 1` probe succeeds and the breaker is CLOSED.
    assert.isFalse(svc.isOpen(TENANT))
    await assert.doesNotReject(() => svc.run(TENANT))
    assert.equal(svc.getMetrics(TENANT)!.state, 'CLOSED')

    // Partition the tenant DB: every probe now rejects with a connection error.
    svc.partitioned = true

    // Fire probes through the breaker until it trips. With volumeThreshold=1 and
    // threshold=1 (100% error over the rolling window) one in-volume failure is
    // enough, but we allow a small margin so the assertion is on the END STATE,
    // not on opossum's exact internal accounting.
    for (let i = 0; i < 5; i++) {
      await svc.run(TENANT).catch(() => {})
      if (svc.isOpen(TENANT)) break
    }

    assert.isTrue(svc.isOpen(TENANT), 'breaker must trip OPEN under a sustained partition')
    assert.equal(svc.getMetrics(TENANT)!.state, 'OPEN')

    // While OPEN the breaker fast-fails: the probe is skipped and the call
    // rejects with opossum's EOPENBREAKER rather than the probe's own error.
    const openErr = await svc
      .run(TENANT)
      .then(() => null)
      .catch((e) => e)
    assert.isNotNull(openErr)
    assert.isTrue(
      svc.isOpenRejection(openErr),
      'an OPEN breaker must fast-fail with EOPENBREAKER (probe skipped)'
    )

    // The dependency comes back. After resetTimeout (250ms) opossum moves the
    // breaker to HALF_OPEN and lets one trial probe through; we give it margin.
    svc.partitioned = false
    await new Promise((r) => setTimeout(r, 400))

    // The single HALF_OPEN trial probe now hits the live DB and succeeds, which
    // closes the breaker (the 'close' listener fires).
    await assert.doesNotReject(
      () => svc.run(TENANT),
      'the recovery probe must succeed once the partition heals'
    )
    assert.isFalse(svc.isOpen(TENANT), 'a successful HALF_OPEN probe must re-close the breaker')
    assert.equal(svc.getMetrics(TENANT)!.state, 'CLOSED')
  })
})
