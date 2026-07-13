import { test } from '@japa/runner'
import { CONFIG_DEFAULTS, resolveConfig } from '../../../../src/config_defaults.js'
import { getConfig } from '../../../../src/config.js'
import { setupTestConfig } from '../../../helpers/config.js'
import type { MultitenancyConfig } from '../../../../src/types/config.js'

/**
 * CFG-1: config resolution merges the single `CONFIG_DEFAULTS`, so `getConfig()`
 * returns a fully-resolved config and read sites drop their `?? DEFAULT_*`
 * fallbacks. These lock the merge contract the read sites now depend on: the
 * always-present blocks are filled, `0` survives (it is a valid tunable value),
 * host values win, feature toggles are NOT materialized, and the merge is
 * idempotent (so `defineConfig` then `setConfig` re-resolving is a no-op).
 *
 * The bounds checker keeps validating raw input (a partial cast), so this
 * mirrors that spec's permissive cast to focus on the field under test.
 */
function config(overrides: Record<string, unknown>): MultitenancyConfig {
  return overrides as unknown as MultitenancyConfig
}

test.group('CFG-1 config resolution', () => {
  test('fills the always-present blocks from CONFIG_DEFAULTS when omitted', ({ assert }) => {
    const resolved = resolveConfig(config({}))

    assert.deepEqual(resolved.circuitBreaker, CONFIG_DEFAULTS.circuitBreaker)
    assert.equal(resolved.queue.maxOpenQueues, CONFIG_DEFAULTS.queue.maxOpenQueues)
    assert.equal(resolved.queue.queueIdleGraceMs, CONFIG_DEFAULTS.queue.queueIdleGraceMs)
    assert.equal(resolved.isolation.driver, 'schema-pg')
    assert.equal(
      resolved.isolation.maxTenantConnections,
      CONFIG_DEFAULTS.isolation.maxTenantConnections
    )
    assert.equal(
      resolved.isolation.evictionGracePeriodMs,
      CONFIG_DEFAULTS.isolation.evictionGracePeriodMs
    )
  })

  test('preserves an explicit 0 rather than clobbering it back to the default', ({ assert }) => {
    // `0` is valid: it disables opossum's volume gate / the eviction grace window.
    // A `{ ...defaults, ...input }` merge on an absent key would keep `0`, but the
    // per-field `??` is what guarantees a supplied `0` survives.
    const resolved = resolveConfig(
      config({
        circuitBreaker: {
          threshold: 50,
          resetTimeout: 1,
          rollingCountTimeout: 1,
          volumeThreshold: 0,
        },
        isolation: { driver: 'schema-pg', evictionGracePeriodMs: 0 },
      })
    )
    assert.equal(resolved.circuitBreaker.volumeThreshold, 0)
    assert.equal(resolved.isolation.evictionGracePeriodMs, 0)
  })

  test('host values win over the defaults', ({ assert }) => {
    const resolved = resolveConfig(
      config({
        circuitBreaker: {
          threshold: 12,
          resetTimeout: 111,
          rollingCountTimeout: 222,
          volumeThreshold: 7,
          maxTrackedCircuits: 42,
        },
        queue: { maxOpenQueues: 9, queueIdleGraceMs: 8 },
        isolation: { driver: 'database-pg', maxTenantConnections: 3, tenantDatabasePrefix: 'db_' },
      })
    )
    assert.equal(resolved.circuitBreaker.maxTrackedCircuits, 42)
    assert.equal(resolved.queue.maxOpenQueues, 9)
    assert.equal(resolved.isolation.driver, 'database-pg')
    assert.equal(resolved.isolation.maxTenantConnections, 3)
    // A per-driver field the host set passes through untouched…
    assert.equal(resolved.isolation.tenantDatabasePrefix, 'db_')
    // …and an unset one is still filled from defaults.
    assert.equal(
      resolved.isolation.evictionGracePeriodMs,
      CONFIG_DEFAULTS.isolation.evictionGracePeriodMs
    )
  })

  test('fills resolver.cache tunables only when the cache block is present', ({ assert }) => {
    // Cache off: the toggle stays absent so the feature stays off.
    const noCache = resolveConfig(config({ resolver: { expectedHostSuffix: 'app.com' } }))
    assert.isUndefined(noCache.resolver?.cache)

    // Cache on: ttlMs/maxEntries are filled, `enabled` is preserved.
    const withCache = resolveConfig(config({ resolver: { cache: { enabled: true } } }))
    assert.equal(withCache.resolver?.cache?.enabled, true)
    assert.equal(withCache.resolver?.cache?.ttlMs, CONFIG_DEFAULTS.resolver.cache.ttlMs)
    assert.equal(withCache.resolver?.cache?.maxEntries, CONFIG_DEFAULTS.resolver.cache.maxEntries)
  })

  test('does not materialize feature toggles that mean "off" when absent', ({ assert }) => {
    const resolved = resolveConfig(config({}))
    // Materializing any of these would break their presence gates (the
    // impersonation-secret boot check, the empty-replica short-circuit, the
    // permissive quota fallback).
    assert.isUndefined(resolved.plans)
    assert.isUndefined(resolved.impersonation)
    assert.isUndefined(resolved.tenantReadReplicas)
    assert.isUndefined(resolved.resolver)
  })

  test('materializing isolation leaves the per-driver sub-fields undefined when unset', ({
    assert,
  }) => {
    // isolation is always present in resolved config, but its per-driver options
    // must stay undefined when the host did not set them: vector_provisioning reads
    // `isolation?.provisionConnectionName === undefined` and built_in_drivers spreads
    // each option only when `!== undefined`. Filling them would change driver wiring.
    const resolved = resolveConfig(config({ isolation: { driver: 'schema-pg' } }))
    assert.isUndefined(resolved.isolation.provisionConnectionName)
    assert.isUndefined(resolved.isolation.templateConnectionName)
    assert.isUndefined(resolved.isolation.tenantDatabasePrefix)
    assert.isUndefined(resolved.isolation.rowScopeTables)
    assert.isUndefined(resolved.isolation.rowScopeColumn)
    assert.isUndefined(resolved.isolation.enforceConnectionCap)
  })

  test('passes unknown satellite config blocks through untouched', ({ assert }) => {
    // billing/backup are contributed onto MultitenancyConfig by each satellite's
    // registry augmentation; core never declares them. The top-level spread must
    // carry them through verbatim so the satellite providers still read their block.
    const billing = { driver: 'stripe', stripe: { apiKey: 'sk_test' } }
    const backup = { storagePath: '/tmp/backups' }
    const resolved = resolveConfig(config({ billing, backup })) as Record<string, unknown>
    assert.deepEqual(resolved.billing, billing)
    assert.deepEqual(resolved.backup, backup)
  })

  test('is idempotent: re-resolving a resolved config is a no-op', ({ assert }) => {
    const input = config({
      circuitBreaker: {
        threshold: 40,
        resetTimeout: 1,
        rollingCountTimeout: 1,
        volumeThreshold: 0,
      },
      queue: {
        tenantQueuePrefix: 'q_',
        defaultConcurrency: 1,
        attempts: 3,
        redis: { host: 'h', port: 1 },
      },
      isolation: { driver: 'schema-pg' },
      resolver: { cache: { enabled: true, ttlMs: 5 } },
    })
    const once = resolveConfig(input)
    const twice = resolveConfig(once as unknown as MultitenancyConfig)
    assert.deepEqual(twice, once)
  })

  test('getConfig() returns the resolved shape after setConfig', ({ assert }) => {
    setupTestConfig() // standard testConfig omits the optional tunables
    const cfg = getConfig()
    assert.equal(
      cfg.circuitBreaker.maxTrackedCircuits,
      CONFIG_DEFAULTS.circuitBreaker.maxTrackedCircuits
    )
    assert.equal(cfg.queue.maxOpenQueues, CONFIG_DEFAULTS.queue.maxOpenQueues)
    assert.equal(cfg.isolation.driver, 'schema-pg')
    assert.equal(cfg.isolation.maxTenantConnections, CONFIG_DEFAULTS.isolation.maxTenantConnections)
  })
})
