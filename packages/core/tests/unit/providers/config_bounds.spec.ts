import { test } from '@japa/runner'
import { assertConfigBounds } from '../../../src/providers/assert_config_bounds.js'
import type { MultitenancyConfig } from '../../../src/types/config.js'

/**
 * The bounds checker only reads a handful of optional numeric paths, so each
 * case passes a deliberately partial config. A permissive cast keeps the test
 * focused on the field under check rather than on satisfying the full
 * MultitenancyConfig shape (mirrors the casting in validate_driver_choice.spec).
 */
function config(overrides: Record<string, unknown>): MultitenancyConfig {
  return overrides as unknown as MultitenancyConfig
}

test.group('assertConfigBounds()', () => {
  test('passes when every tunable is omitted (defaults apply)', ({ assert }) => {
    assert.doesNotThrow(() => assertConfigBounds(config({})))
  })

  test('rejects a zero connection cap', ({ assert }) => {
    assert.throws(
      () =>
        assertConfigBounds(config({ isolation: { driver: 'schema-pg', maxTenantConnections: 0 } })),
      /isolation\.maxTenantConnections must be >= 1, got 0/
    )
  })

  test('allows a zero eviction grace window but rejects a negative one', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertConfigBounds(config({ isolation: { driver: 'schema-pg', evictionGracePeriodMs: 0 } }))
    )
    assert.throws(
      () =>
        assertConfigBounds(
          config({ isolation: { driver: 'schema-pg', evictionGracePeriodMs: -1 } })
        ),
      /isolation\.evictionGracePeriodMs must be >= 0/
    )
  })

  test('rejects a circuit threshold outside 1..100', ({ assert }) => {
    const cb = (threshold: number) =>
      config({
        circuitBreaker: { threshold, resetTimeout: 1, rollingCountTimeout: 1, volumeThreshold: 1 },
      })
    assert.throws(
      () => assertConfigBounds(cb(0)),
      /circuitBreaker\.threshold must be between 1 and 100/
    )
    assert.throws(
      () => assertConfigBounds(cb(101)),
      /circuitBreaker\.threshold must be between 1 and 100/
    )
    assert.doesNotThrow(() => assertConfigBounds(cb(50)))
  })

  test('allows circuitBreaker.volumeThreshold = 0 (opossum disables the volume gate)', ({
    assert,
  }) => {
    assert.doesNotThrow(() =>
      assertConfigBounds(
        config({
          circuitBreaker: {
            threshold: 50,
            resetTimeout: 1,
            rollingCountTimeout: 1,
            volumeThreshold: 0,
          },
        })
      )
    )
    assert.throws(
      () =>
        assertConfigBounds(
          config({
            circuitBreaker: {
              threshold: 50,
              resetTimeout: 1,
              rollingCountTimeout: 1,
              volumeThreshold: -1,
            },
          })
        ),
      /circuitBreaker\.volumeThreshold must be >= 0/
    )
  })

  test('rejects a zero queue.maxOpenQueues', ({ assert }) => {
    assert.throws(
      () => assertConfigBounds(config({ queue: { maxOpenQueues: 0 } })),
      /queue\.maxOpenQueues must be >= 1/
    )
  })

  test('rejects resolver cache ttl/maxEntries below 1', ({ assert }) => {
    assert.throws(
      () => assertConfigBounds(config({ resolver: { cache: { enabled: true, ttlMs: 0 } } })),
      /resolver\.cache\.ttlMs must be >= 1/
    )
    assert.throws(
      () => assertConfigBounds(config({ resolver: { cache: { enabled: true, maxEntries: 0 } } })),
      /resolver\.cache\.maxEntries must be >= 1/
    )
  })

  test('rejects impersonation durations below the 60s floor', ({ assert }) => {
    assert.throws(
      () =>
        assertConfigBounds(
          config({ impersonation: { secret: 'x'.repeat(32), defaultDuration: 30 } })
        ),
      /impersonation\.defaultDuration must be >= 60/
    )
  })

  test('rejects impersonation maxDuration below defaultDuration', ({ assert }) => {
    assert.throws(
      () =>
        assertConfigBounds(
          config({
            impersonation: { secret: 'x'.repeat(32), defaultDuration: 3600, maxDuration: 600 },
          })
        ),
      /impersonation\.maxDuration must be >= impersonation\.defaultDuration/
    )
  })

  test('rejects a non-finite value', ({ assert }) => {
    assert.throws(
      () =>
        assertConfigBounds(
          config({ isolation: { driver: 'schema-pg', maxTenantConnections: Number.NaN } })
        ),
      /isolation\.maxTenantConnections must be >= 1/
    )
  })

  test('passes a fully valid set of tunables', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertConfigBounds(
        config({
          isolation: {
            driver: 'schema-pg',
            maxTenantConnections: 50,
            evictionGracePeriodMs: 30_000,
          },
          circuitBreaker: {
            threshold: 50,
            resetTimeout: 30_000,
            rollingCountTimeout: 10_000,
            volumeThreshold: 5,
            maxTrackedCircuits: 5_000,
          },
          queue: {
            attempts: 3,
            defaultConcurrency: 5,
            maxOpenQueues: 100,
            queueIdleGraceMs: 30_000,
          },
          resolver: { cache: { enabled: true, ttlMs: 10_000, maxEntries: 10_000 } },
          impersonation: { secret: 'x'.repeat(32), defaultDuration: 3600, maxDuration: 86_400 },
          maintenance: { retryAfterSeconds: 600 },
          tenantReadReplicas: { hosts: [], maxReplicaConnections: 50 },
        })
      )
    )
  })
})
