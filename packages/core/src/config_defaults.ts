import type { MultitenancyConfig, ResolvedMultitenancyConfig } from './types/config.js'
import {
  DEFAULT_MAX_TENANT_CONNECTIONS,
  DEFAULT_EVICTION_GRACE_MS,
} from './services/isolation/connection_lru.js'
import { DEFAULT_OPERATIONAL_CONNECTION_BUDGET } from './services/isolation/operational_budget.js'
import {
  DEFAULT_RESOLUTION_CACHE_TTL_MS,
  DEFAULT_RESOLUTION_CACHE_MAX,
} from './services/tenant_resolution_cache.js'

/**
 * CFG-1 — the ONE place default values for the multitenancy tunables live.
 *
 * Before this, every read site defaulted on its own (`getConfig().queue.maxOpenQueues
 * ?? DEFAULT_MAX_OPEN_QUEUES`), with the `DEFAULT_*` constants scattered across a
 * dozen modules. `resolveConfig` below merges these once at `defineConfig` /
 * `setConfig` time, so `getConfig()` returns a fully-resolved config and the read
 * sites read a value directly.
 *
 * Values that another module already owns as its documented default (the
 * connection LRU caps, the resolution-cache TTL/size) are referenced from there
 * rather than re-spelled, so there is still exactly one literal per value. Values
 * with no other owner (the circuit-breaker tuning, the queue-handle cap, the
 * replica-connection cap) are the literals here.
 *
 * Only the always-present blocks are resolved (see {@link ResolvedMultitenancyConfig}).
 * Genuine feature toggles keep their own presence gate and fall back to the
 * matching entry here when they need a value while unconfigured.
 */
export const CONFIG_DEFAULTS = {
  // Mirrors the documented circuitBreaker examples. `circuitBreaker` is a
  // required input block, so a typed config supplies threshold/resetTimeout/
  // rollingCountTimeout/volumeThreshold; these fill an untyped or partial one and
  // always supply maxTrackedCircuits (the only optional field).
  circuitBreaker: {
    threshold: 50,
    resetTimeout: 30_000,
    rollingCountTimeout: 10_000,
    volumeThreshold: 5,
    maxTrackedCircuits: 5_000,
  },
  // The dispatch-handle LRU: its own cap, and an idle-grace window that mirrors
  // the connection LRU's (hence the shared constant).
  queue: {
    maxOpenQueues: 100,
    queueIdleGraceMs: DEFAULT_EVICTION_GRACE_MS,
  },
  // Absent isolation resolves to schema-pg with these connection-pool caps.
  isolation: {
    maxTenantConnections: DEFAULT_MAX_TENANT_CONNECTIONS,
    evictionGracePeriodMs: DEFAULT_EVICTION_GRACE_MS,
    operationalConnectionBudget: DEFAULT_OPERATIONAL_CONNECTION_BUDGET,
    // Off by default: provision and migrate stay separate lifecycles unless a host
    // opts in (a UI-onboarding app sets it true so tenants are born at head).
    migrateOnProvision: false,
  },
  // Filled only when the host set a `resolver.cache` block (opt-in via `enabled`).
  resolver: {
    cache: {
      ttlMs: DEFAULT_RESOLUTION_CACHE_TTL_MS,
      maxEntries: DEFAULT_RESOLUTION_CACHE_MAX,
    },
  },
  // Read-replica connection cap: its own default (documented as 50), decoupled
  // from the primary connection cap. Sourced here for the unconfigured read in
  // ReadReplicaService, which keeps its presence gate on `tenantReadReplicas`.
  tenantReadReplicas: {
    maxReplicaConnections: 50,
  },
} as const

/**
 * Merge {@link CONFIG_DEFAULTS} into an input config, producing the resolved
 * shape `getConfig()` returns. Pure and idempotent: re-resolving an
 * already-resolved config is a no-op (present values win over defaults), so it is
 * safe for both `defineConfig` (at config-file eval) and `setConfig` (the store
 * choke point that also catches untyped configs the host wrote without
 * `defineConfig`).
 *
 * Only the always-present blocks are materialized. Feature toggles pass through
 * untouched EXCEPT `resolver.cache`, whose numeric tunables are filled when — and
 * only when — the host set the cache block, so an unconfigured cache stays absent
 * (feature off).
 */
export function resolveConfig(config: MultitenancyConfig): ResolvedMultitenancyConfig {
  // Per-field `??` (not spread-defaults-first) so the merge matches the old read
  // sites byte-for-byte: `0` is a valid value (`circuitBreaker.volumeThreshold`
  // disables the volume gate, `evictionGracePeriodMs` disables the grace window),
  // and `??` keeps it where `{ ...defaults, ...input }` on an explicit `undefined`
  // would clobber it back to the default. Fields spread first, then the resolved
  // tunables overwrite, so a host's other block fields (redis, tenantQueuePrefix,
  // the per-driver isolation options) pass through untouched.
  const cb = config.circuitBreaker
  const q = config.queue
  const iso = config.isolation

  const resolved: MultitenancyConfig = {
    ...config,
    circuitBreaker: {
      ...cb,
      threshold: cb?.threshold ?? CONFIG_DEFAULTS.circuitBreaker.threshold,
      resetTimeout: cb?.resetTimeout ?? CONFIG_DEFAULTS.circuitBreaker.resetTimeout,
      rollingCountTimeout:
        cb?.rollingCountTimeout ?? CONFIG_DEFAULTS.circuitBreaker.rollingCountTimeout,
      volumeThreshold: cb?.volumeThreshold ?? CONFIG_DEFAULTS.circuitBreaker.volumeThreshold,
      maxTrackedCircuits:
        cb?.maxTrackedCircuits ?? CONFIG_DEFAULTS.circuitBreaker.maxTrackedCircuits,
    },
    queue: {
      ...q,
      maxOpenQueues: q?.maxOpenQueues ?? CONFIG_DEFAULTS.queue.maxOpenQueues,
      queueIdleGraceMs: q?.queueIdleGraceMs ?? CONFIG_DEFAULTS.queue.queueIdleGraceMs,
    },
    isolation: {
      ...iso,
      driver: iso?.driver ?? 'schema-pg',
      maxTenantConnections:
        iso?.maxTenantConnections ?? CONFIG_DEFAULTS.isolation.maxTenantConnections,
      evictionGracePeriodMs:
        iso?.evictionGracePeriodMs ?? CONFIG_DEFAULTS.isolation.evictionGracePeriodMs,
      operationalConnectionBudget:
        iso?.operationalConnectionBudget ?? CONFIG_DEFAULTS.isolation.operationalConnectionBudget,
      migrateOnProvision: iso?.migrateOnProvision ?? CONFIG_DEFAULTS.isolation.migrateOnProvision,
    },
  }

  const cache = config.resolver?.cache
  if (cache) {
    resolved.resolver = {
      ...config.resolver,
      cache: {
        ...cache,
        ttlMs: cache.ttlMs ?? CONFIG_DEFAULTS.resolver.cache.ttlMs,
        maxEntries: cache.maxEntries ?? CONFIG_DEFAULTS.resolver.cache.maxEntries,
      },
    }
  }

  return resolved as ResolvedMultitenancyConfig
}
