import type { HttpContext } from '@adonisjs/core/http'
import type { DeclarativeHooks } from '../services/hook_registry.js'
import type { TenantModelContract } from './contracts.js'
import type { IsolationConfig } from './config/isolation.js'
import type { TenantResolver } from '../services/resolvers/resolver.js'

// The large isolation config shape lives in ./config/isolation.ts; re-export it
// here so the public `./types` surface and every `from '../types/config.js'`
// import keep resolving exactly as before. Satellite config blocks (billing,
// backup) are NOT declared here — see SatelliteConfigRegistry below.
export type { IsolationConfig, IsolationDriverChoice } from './config/isolation.js'

/**
 * Open registry of satellite-contributed config blocks. Core declares it empty:
 * the leaf satellites (`@adonisjs-lasagna/billing`, `@adonisjs-lasagna/backup`)
 * each augment it via `declare module '@adonisjs-lasagna/saas-tenancy/types'` so
 * their config block (`billing` / `backup`) appears on `MultitenancyConfig` ONLY
 * in the compilation that imports the satellite. This keeps core's frozen public
 * type free of satellite-specific shapes (a host that never installs billing
 * sees no `billing` key) while the satellite's own code keeps `getConfig().billing`
 * fully typed. Adding a field here from core would re-freeze satellite config into
 * the core type — the exact coupling this indirection removes.
 */
export interface SatelliteConfigRegistry {}

/**
 * Optional MEMBERSHIP gate: does the authenticated caller belong to the
 * resolved tenant? The package routes by tenant id and verifies the tenant
 * exists + is active, but it never checks membership; that is the host's job,
 * and skipping it is the classic cross-tenant IDOR (a swapped `x-tenant-id`
 * served against another tenant's schema). This is the FIRST line of defense,
 * not full authorization: keep role/permission checks in your own policies.
 * Wire it to your auth layer; return `false` (or throw) to deny. Runs only on
 * the `TenantGuardMiddleware` path (it needs the request principal).
 *
 * @example // @adonisjs/auth session guard (the common case)
 *   authorizeTenantAccess: (ctx, tenant) => ctx.auth?.user?.tenantId === tenant.id
 *
 * @example // membership table (a user can belong to several tenants)
 *   authorizeTenantAccess: async (ctx, tenant) =>
 *     ctx.auth?.user != null &&
 *     (await Membership.query()
 *       .where('user_id', ctx.auth.user.id)
 *       .where('tenant_id', tenant.id)
 *       .first()) != null
 */
export type TenantAccessAuthorizer = (
  ctx: HttpContext,
  tenant: TenantModelContract
) => boolean | Promise<boolean>

/**
 * Optional GDPR anonymizer SEAM. The package never imports your models, so YOU
 * decide which columns are PII and how to mask them. `tenant:gdpr:anonymize`
 * invokes this INSIDE `tenancy.run(tenant)`, so your model queries hit the
 * tenant's own schema. Use it for Art.17 erasure-by-anonymization when a legal
 * retention obligation means you must keep the row but strip the personal data.
 * Honor `dryRun` (count, do not write) and return `{ affected }` for the audit
 * trail. If this is not configured, `tenant:gdpr:anonymize` fails loudly — that
 * is the signal your implementation is missing, not a bug.
 *
 * @example
 *   compliance: {
 *     anonymize: async ({ tenant, dryRun }) => {
 *       const users = await User.query() // your model, not a package import
 *       if (dryRun) return { affected: users.length }
 *       for (const u of users) {
 *         u.email = `redacted+${u.id}@anon.invalid`
 *         u.fullName = 'Redacted'
 *         u.phone = null
 *         await u.save() // keeps non-PII rows (invoices, etc.) for legal retention
 *       }
 *       return { affected: users.length }
 *     },
 *   }
 */
export type TenantAnonymizer = (args: {
  tenant: TenantModelContract
  reason?: string
  dryRun: boolean
}) => Promise<{ affected?: number } | void>

export type TenantResolverStrategy =
  | 'subdomain'
  | 'header'
  | 'path'
  | 'domain-or-subdomain'
  | 'request-data'

/**
 * Controls how `TenantAdapter` routes a model query when there is no active
 * tenancy context (no `request.tenant()`/guard has run and no
 * `tenancy.run()` scope is open).
 */
export interface ResolverConfig {
  /**
   *  - `false` (default): the adapter consults the resolver chain synchronously
   *    (`resolveSync`) and, in the HTTP path, trusts the id already resolved by
   *    `request.tenant()` (the package seeds the tenant log context at boot so
   *    `tenancy.currentId()` reflects the guard). This makes custom and
   *    domain-based resolvers route model queries consistently. Async-only
   *    resolvers are skipped on the synchronous routing path.
   *  - `true`: restores the historical 0.x behavior — the adapter uses only the
   *    built-in `resolverStrategy` switch on this fallback. Custom resolvers
   *    registered in `resolverChain` are NOT consulted for model-query routing,
   *    and a custom-domain resolver cannot route a raw model query.
   *
   * Defaults to `false` as of 1.0 (was `true` in 0.x). Set it to `true` only if
   * you depended on the old `resolverStrategy`-only fallback.
   */
  legacyAdapterFallback?: boolean
  /**
   * Allowlist of host suffixes the host-based resolvers (`subdomain`,
   * `domain-or-subdomain`) and the custom-domain middleware will accept. When
   * set, a request whose host is neither equal to nor a sub-host of one of
   * these suffixes is refused BEFORE any tenant extraction or `findByDomain`
   * lookup, so a spoofed `X-Forwarded-Host` (under a permissive proxy trust)
   * cannot route to a tenant on an unexpected host.
   *
   * `'app.com'` matches `app.com` and `acme.app.com` but not `app.com.evil.io`.
   * Provide several (e.g. your apex plus known custom-domain suffixes) as an
   * array. Leave UNSET only when you intentionally accept arbitrary customer
   * domains; then you MUST pin host trust at the proxy layer (do not trust
   * `X-Forwarded-Host` from untrusted hops). A host strategy in production with
   * this unset fails boot (see the Security guide).
   */
  expectedHostSuffix?: string | string[]
  /**
   * Opt-in per-process cache for the tenant-registry lookup that the HTTP guard
   * and universal middleware run on EVERY request (`repo.findById`). Without it,
   * every tenant request makes a round-trip to the shared backoffice DB before
   * any tenant work — a fixed latency add and a contention point that funnels
   * all traffic through one pool.
   *
   * When enabled, a resolved tenant is cached in-process (per pod) for `ttlMs`.
   * In-process invalidation is wired to the tenant lifecycle events (suspend /
   * activate / update / delete / maintenance), so the entry is dropped the moment
   * one of those events fires ON THIS POD.
   *
   * IMPORTANT — the invalidation depends on the event actually being emitted:
   *   - The `@adonisjs-lasagna/admin` package emits these events for you on every
   *     status change it performs.
   *   - The core emits `TenantDeleted` (uninstall) and the provisioning events,
   *     but it does NOT emit suspend/activate/maintenance on its own. If you
   *     change a tenant's status by any other means (your own admin code, a raw
   *     `UPDATE`, a custom service), you MUST dispatch the matching event
   *     (`TenantSuspended`, etc.) yourself, or the cached entry will keep serving
   *     until it expires. Without that, suspending a tenant takes effect only
   *     after `ttlMs` even on the pod that performed the change.
   *
   * Cross-instance propagation is ALWAYS bounded by `ttlMs` regardless of events:
   * a tenant suspended on one pod may keep serving on another for up to `ttlMs`
   * (events are per-process; there is no shared invalidation bus). Keep `ttlMs`
   * short (seconds) so that window stays small. Treat the cache as a throughput
   * optimization with bounded staleness, not as an instant kill-switch — for an
   * immediate, fleet-wide suspend, gate on a fresh status check or disable the
   * cache.
   *
   * IMPORTANT: the cached `request.tenant()` is shared across concurrent requests
   * in the same process — treat it as READ-ONLY. For a mutate-then-save flow,
   * load a fresh instance through your repository instead of mutating the
   * resolved request tenant. Disabled by default (behaviour is byte-for-byte
   * unchanged unless you opt in).
   */
  cache?: {
    /** Turn the cache on. Default `false`. */
    enabled?: boolean
    /**
     * Time-to-live per cached tenant, in ms. Also the upper bound on how long a
     * cross-pod status change can take to propagate. Default `10_000` (10s).
     */
    ttlMs?: number
    /**
     * Max tenants cached per process before the least-recently-used entry is
     * evicted (keeps memory bounded under a very large tenant base). Default
     * `10_000`.
     */
    maxEntries?: number
  }
}

/**
 * The resolution-cache block of {@link ResolverConfig}, with `undefined`
 * stripped. The single source of truth for the cache shape so call sites in
 * `extensions/request.ts` don't hand-duplicate `{ enabled?, ttlMs?, maxEntries? }`.
 */
export type ResolverCacheConfig = NonNullable<ResolverConfig['cache']>

/**
 * Per-strategy configuration the resolvers consume. Optional — the built-in
 * resolvers fall back to sensible defaults when these blocks are absent.
 */
export interface RequestDataResolverConfig {
  /** Query-string key. Default `tenant_id`. */
  queryKey?: string
  /** Request-body key (JSON / form / multipart). Default `tenant_id`. */
  bodyKey?: string
  /**
   * Which sources to read, in precedence order. The first source that yields a
   * value wins. Default `['query', 'body']` (query before body, the historical
   * order). Set `['body', 'query']` to prefer the body, or a single-element
   * array to read only one source.
   */
  sourceOrder?: Array<'query' | 'body'>
}

export interface BackupRetentionTier {
  /** Minimum hours between scheduled backups for tenants on this tier. */
  intervalHours: number
  /** How many recent backup archives to keep; older ones are purged. */
  keepLast: number
}

export interface BackupRetentionConfig {
  /** Tier name applied when no per-tenant resolver is configured or it returns undefined. */
  defaultTier: string
  /** Named tiers; the user picks which one applies to a tenant via `getTier`. */
  tiers: Record<string, BackupRetentionTier>
  /** Optional per-tenant tier resolver. Must return a tier name from `tiers`. */
  getTier?: (tenant: TenantModelContract) => string | undefined | Promise<string | undefined>
}

/**
 * A plan declares numeric usage limits keyed by quota name. Apps assign
 * plans to tenants via `plans.getPlan(tenant)`.
 *
 * Limits are interpreted as either:
 *   - rolling daily counters (e.g. `apiCallsPerDay`) tracked via QuotaService.track
 *   - snapshot values (e.g. `seats`, `storageMb`) reported via QuotaService.setUsage
 */
export interface PlanDefinition {
  limits: Record<string, number>
  /**
   * Optional per-plan request rate limit, consumed by the `enforceRateLimit()`
   * middleware. When omitted, the plan is not routable through
   * `enforceRateLimit()` (the middleware throws), so free/pro tiers can carry
   * different ceilings while an unlimited plan simply declares no `rateLimit`.
   */
  rateLimit?: {
    /** Max requests per window. */
    limit: number
    /** Rolling window duration in seconds. */
    windowSeconds: number
  }
}

export interface PlansConfig {
  defaultPlan: string
  definitions: Record<string, PlanDefinition>
  /**
   * Per-tenant plan resolver. Must return a plan name from `definitions`.
   * When omitted and `storage` is `'tenant_plans'` (or auto and the table
   * exists), the package falls back to reading the `tenant_plans` row
   * populated by `QuotaService.assignPlan` (storage-backed default).
   */
  getPlan?: (tenant: TenantModelContract) => string | undefined | Promise<string | undefined>
  /**
   * Where the tenant→plan assignment lives:
   *   - `'config-only'` (default for backwards compat when `getPlan` is set):
   *     resolution comes only from `getPlan`. `assignPlan` becomes a no-op
   *     unless the host explicitly wires it.
   *   - `'tenant_plans'`: resolution falls back to the backoffice
   *     `tenant_plans` table when `getPlan` is undefined. `assignPlan`
   *     writes to this table.
   *   - `'auto'` (default when omitted): probe at boot for the table; use
   *     it if present, else `config-only`.
   */
  storage?: 'config-only' | 'tenant_plans' | 'auto'
  /**
   * Emit a `QuotaTracked` event after every `track`/`consume` call. Default
   * `false` (zero overhead). Set to `true` to enable the metered-billing
   * auto-bridge to Stripe — `BillingService` listens and reports usage.
   */
  emitTracked?: boolean
  /**
   * Operator-global cost ceiling per quota name, a tenant-independent cap that
   * `QuotaService.reserve` checks in the SAME atomic step as the per-tenant
   * budget (both must fit or nothing is held). It guards a shared managed
   * provider account from one tenant exhausting it (denial of wallet). Absent for
   * a quota means no ceiling. Only the reserve/settle/release path enforces it;
   * `consume` and `track` ignore it. Applies to standalone/Sentinel Redis.
   */
  operatorCeiling?: Record<string, number>
  /**
   * Worst-case lifetime in milliseconds of a single `QuotaService.reserve` hold
   * before Redis expiry reclaims an orphan left by a crashed process. Default
   * `120000` (2 minutes). A live stream refreshes its hold on every `settle`, so
   * this only bounds a CRASHED stream's stranded budget; set it comfortably above
   * the longest expected single streamed response.
   */
  reservationTtlMs?: number
}

export type ReadReplicaStrategy = 'round-robin' | 'random' | 'sticky'

export interface ReadReplicaHost {
  host: string
  port?: number
  user?: string
  password?: string
  /** Optional human-readable label for telemetry. */
  name?: string
}

export interface ReadReplicasConfig {
  /** Pool of read-only replicas. */
  hosts: ReadReplicaHost[]
  /**
   * `round-robin` (default): cycles through hosts globally.
   * `random`: picks at random per call.
   * `sticky`: hashes tenant id → always the same replica for a given tenant.
   */
  strategy?: ReadReplicaStrategy
  /**
   * Connection name suffix for the registered Lucid replica connection.
   * Default: `_read`. Final connection name is
   * `${tenantConnectionNamePrefix}${tenantId}${suffix}_${hostIndex}`.
   */
  connectionSuffix?: string
  /**
   * Max replica connections kept open in Lucid's manager before the oldest
   * IDLE one is evicted. Replica connections multiply by host
   * (`tenants * hosts`), so this is a separate budget from
   * `isolation.maxTenantConnections`. Default 50. The same in-use grace window
   * applies, so an in-flight read is never severed.
   */
  maxReplicaConnections?: number
}

export interface RoutingConfig {
  /**
   * Auto-load `start/tenant.ts` and `start/universal.ts` after the router
   * macros are installed. Defaults to `true`. Set to `false` if you want
   * to wire the files yourself (e.g. via Adonis preloads).
   */
  autoLoad?: boolean
  /** Filename inside `start/` to load tenant routes from. Default: `tenant.ts`. */
  tenantRoutesFile?: string
  /** Filename inside `start/` to load universal routes from. Default: `universal.ts`. */
  universalRoutesFile?: string
}

/**
 * String-literal union describing how a subsystem reacts when a backing dependency such as Redis or
 * PostgreSQL errors out. A value of `'fail-open'` keeps the request available by skipping the failed
 * check, while `'fail-closed'` preserves correctness by rejecting the request, typically with a 503.
 * Consumed by `ResilienceConfig` and `ResilienceService` to drive per-dependency degradation behavior.
 */
export type FailurePolicy = 'fail-open' | 'fail-closed'

/**
 * Unified, typed degradation policy consumed by `ResilienceService`. Lets ops
 * decide, per dependency, whether an outage should fail OPEN (stay available by
 * skipping the check) or fail CLOSED (preserve correctness by returning 503).
 * Replaces the per-subsystem ad-hoc handling. All fields optional; sensible
 * defaults apply.
 */
export interface ResilienceConfig {
  /** Default for any (dependency, operation) not overridden below. Default `'fail-closed'`. */
  defaultPolicy?: FailurePolicy
  /** Per-consumer overrides for the Redis dependency. */
  redis?: {
    /** `QuotaService.consume/track`. Default `'fail-open'` (availability over enforcement). */
    quota?: FailurePolicy
    /** `RateLimitMiddleware`. Default `'fail-closed'` (don't let floods through on an outage). */
    rateLimit?: FailurePolicy
    /** Cache bootstrapper. Default `'fail-open'`. */
    cache?: FailurePolicy
    /** `MetricsService` counters. Default `'fail-open'`. */
    metrics?: FailurePolicy
  }
  /**
   * Emit a `DependencyDegraded` event + log + OpenTelemetry span event on each
   * degradation so ops can alarm. Default `true`.
   */
  observe?: boolean
}

export interface MultitenancyConfig extends SatelliteConfigRegistry {
  backofficeSchemaName: string
  backofficeConnectionName: string
  centralSchemaName: string
  centralConnectionName: string
  tenantConnectionNamePrefix: string
  tenantSchemaPrefix: string
  resolverStrategy: TenantResolverStrategy
  /**
   * Optional: chain multiple resolvers in order. The first one to return a
   * hit wins. When provided, this overrides `resolverStrategy`.
   *
   * Each entry is either a built-in resolver name (`'header'`, `'subdomain'`, …),
   * the name of an instance you passed in {@link resolvers}, or an inline
   * `TenantResolver` instance — so a custom resolver can be chained without
   * reaching into the registry. Unknown string names fail at boot with a clear
   * config-level error.
   */
  resolverChain?: Array<TenantResolverStrategy | string | TenantResolver>
  /**
   * Optional: register custom `TenantResolver` instances at boot so they can be
   * referenced by name in {@link resolverChain} (or selected via
   * {@link resolverStrategy}). Inline instances placed directly in `resolverChain`
   * are registered too; this bag is for resolvers you want available by name.
   */
  resolvers?: TenantResolver[]
  /**
   * Optional: tune how `TenantAdapter` routes model queries with no active
   * tenancy context. See {@link ResolverConfig}. Defaults preserve the
   * historical behavior.
   */
  resolver?: ResolverConfig
  /**
   * Optional per-request tenant authorization gate run by `TenantGuardMiddleware`
   * after the lifecycle checks. Returns `false` (or throws) to deny with a 403
   * `TenantAccessForbiddenException`. See {@link TenantAccessAuthorizer}.
   */
  authorizeTenantAccess?: TenantAccessAuthorizer
  /**
   * Explicitly acknowledge running WITHOUT a package membership gate
   * (`authorizeTenantAccess`) when a client-controlled resolver strategy
   * (`header` / `path` / `request-data`) is active. Set to `true` only when an
   * equivalent app-layer guard verifies the principal belongs to the resolved
   * tenant, or membership is genuinely out of scope. It silences the
   * cross-tenant-IDOR signal (boot warning + doctor / compliance check) so
   * silence is a deliberate decision rather than an oversight. Leaving it unset
   * with a client-controlled strategy and no `authorizeTenantAccess` is reported
   * as a security risk.
   */
  acknowledgeNoMembershipGate?: boolean
  tenantHeaderKey: string
  baseDomain: string
  /** Settings for the `request-data` resolver. */
  requestData?: RequestDataResolverConfig
  /**
   * Optional isolation block. If omitted, the package falls back to
   * `{ driver: 'schema-pg' }` to preserve v1 behavior.
   */
  isolation?: IsolationConfig
  /**
   * Routing convention. When omitted (or `routing.autoLoad !== false`), the
   * provider will try to import `start/tenant.ts` and `start/universal.ts`
   * after installing the `Route.tenant() / Route.central() / Route.universal()`
   * macros.
   */
  routing?: RoutingConfig
  /**
   * Per-tenant maintenance mode (orthogonal to `suspended`). When omitted,
   * tenants without an `isMaintenance` flag are simply never in maintenance.
   */
  /**
   * Optional impersonation configuration. If `secret` is unset, calls to
   * `ImpersonationService.start()` throw — the package never ships with a
   * default secret.
   */
  impersonation?: {
    /** HMAC secret. MUST be at least 32 chars. */
    secret: string
    /** Default session duration (seconds). Default: 900 (15m). Min 60. */
    defaultDuration?: number
    /** Hard upper bound (seconds). Default: 86400 (24h). */
    maxDuration?: number
    /** Override the header read by `ImpersonationMiddleware`. Default `x-impersonation-token`. */
    headerName?: string
    /** Override the cookie name fallback. Default `__impersonation`. */
    cookieName?: string
  }
  maintenance?: {
    /**
     * Default message returned when a tenant is in maintenance without one
     * of its own. Surfaced in the `TenantMaintenanceException`.
     */
    defaultMessage?: string
    /**
     * Value (in seconds) for the `Retry-After` HTTP header carried on the
     * 503 response. Default: 600 (10 minutes).
     */
    retryAfterSeconds?: number
    /**
     * Optional shared-secret bypass token. Requests presenting this value
     * via the `x-tenant-bypass-maintenance` header skip the maintenance
     * check. Use sparingly; rotate often.
     */
    bypassToken?: string
    /**
     * Header name read for the bypass token. Default: `x-tenant-bypass-maintenance`.
     */
    bypassHeader?: string
  }
  schemaCacheTtl: number
  ignorePaths: string[]
  maintenanceSchedule: {
    backupHour: number
    migrateAllHour: number
  }
  circuitBreaker: {
    threshold: number
    resetTimeout: number
    rollingCountTimeout: number
    volumeThreshold: number
    /**
     * Upper bound on simultaneously-tracked tenant breakers. Past it, the
     * oldest CLOSED breaker is shut down and evicted (it re-creates cheaply on
     * the tenant's next request); OPEN/HALF_OPEN breakers are never evicted.
     * Default: 5000.
     */
    maxTrackedCircuits?: number
  }
  /**
   * Optional unified degradation policy for backing dependencies. When
   * omitted, each consumer uses its documented default (see {@link ResilienceConfig}).
   */
  resilience?: ResilienceConfig
  queue: {
    tenantQueuePrefix: string
    defaultConcurrency: number
    attempts: number
    redis: {
      host: string
      port: number
      username?: string
      password?: string
      db?: number
    }
    /**
     * Upper bound on simultaneously-open per-tenant `Queue` handles kept in
     * `TenantQueueService` (the dispatch path). Each handle owns an ioredis
     * connection, so an unbounded map under high tenant churn would leak one
     * connection per dispatched tenant and eventually exhaust Redis
     * `maxclients`. When over cap, the least-recently-used IDLE handle (one not
     * touched within `queueIdleGraceMs`) is closed and re-created lazily on the
     * next dispatch. Default 100.
     */
    maxOpenQueues?: number
    /**
     * In-use grace window (ms) for the queue-handle LRU above. A handle touched
     * more recently than this is never evicted even over cap, so an in-flight
     * dispatch is never severed. Default 30_000 (mirrors the connection LRU).
     */
    queueIdleGraceMs?: number
  }
  cache: {
    ttl: number
    redis: {
      host: string
      port: number
      username?: string
      password?: string
      db?: number
    }
  }
  onboarding?: {
    wizardTtl: number
    wizardKeyPrefix: string
  }
  hooks?: DeclarativeHooks
  softDelete?: {
    /**
     * Days a soft-deleted tenant's schema is preserved before
     * `tenant:purge-expired` will drop it. Default: 30.
     */
    retentionDays: number
  }
  /**
   * Optional compliance tooling seams. `anonymize` backs `tenant:gdpr:anonymize`
   * (GDPR Art.17 erasure-by-anonymization). See {@link TenantAnonymizer}.
   */
  compliance?: {
    anonymize?: TenantAnonymizer
  }
  plans?: PlansConfig
  tenantReadReplicas?: ReadReplicasConfig
  /**
   * Optional extra `/readyz` dimensions. Both are OFF by default because they
   * probe tenant infrastructure on every readiness call. Both register as
   * NON-critical checks (a failure degrades the pod, it does not 503 it) so a
   * hot pool or a lagging replica sheds traffic without a hard outage.
   */
  health?: {
    /**
     * Register a `tenant_pools` readiness check that fails when any tenant Lucid
     * connection pool is at or over the saturation threshold
     * (`tenantPoolSaturationThreshold`), so the pod can shed load before pools are
     * fully exhausted. Tenant-pool saturation is ALWAYS exposed as a Prometheus
     * gauge (`multitenancy_pool_saturation_ratio`) regardless of this flag; this
     * only controls whether saturation GATES readiness.
     */
    tenantPoolsCheck?: boolean
    /**
     * Saturation ratio (0..1) at which the `tenant_pools` readiness check fails.
     * Defaults to `doctor.poolSaturationWarnRatio` (built-in 0.9) so there is ONE
     * saturation number across the doctor warning, the readiness gate, and the
     * metric. Set to `1` to fail only when a pool is fully exhausted.
     */
    tenantPoolSaturationThreshold?: number
    /**
     * Register a `read_replicas` readiness check that fails when a configured
     * read replica is unreachable or critically lagged. Reuses the `replica_lag`
     * doctor logic; only meaningful when `tenantReadReplicas.hosts` is non-empty.
     */
    readReplicasCheck?: boolean
  }
  /**
   * Optional thresholds for `tenant:doctor` checks. Each field overrides the
   * built-in default. All durations are in seconds unless noted.
   */
  doctor?: {
    /** Minutes a job can sit in `active` before `queue_stuck_check` flags it as stalled. Default 10. */
    queueStalledMinutes?: number
    /** Seconds of replica lag that warrant a `warn` from `replica_lag_check`. Default 30. */
    replicaLagWarnSeconds?: number
    /** Seconds of replica lag that warrant an `error` from `replica_lag_check`. Default 120. */
    replicaLagErrorSeconds?: number
    /** Seconds a query can stay in `pg_stat_activity.state='active'` before warn. Default 30. */
    longQueryWarnSeconds?: number
    /** Seconds before a long query escalates to error. Default 120. */
    longQueryErrorSeconds?: number
    /**
     * Include the RAW SQL text of a long-running query in `long_running_queries`
     * diagnosis meta. **Default `false` (off).** Off, the check emits only a
     * non-reversible `queryFingerprint` so operators can correlate without
     * exposing the statement. The raw text can carry another tenant's secrets or
     * PII as SQL literals, and the doctor report is reachable over HTTP at the
     * admin `/health/report` surface, so it must never be exposed unless a host
     * deliberately opts in (e.g. for local CLI diagnosis on a trusted box).
     */
    includeQueryText?: boolean
    /** Pool utilization (0-1) above which `connection_pool_check` warns. Default 0.9. */
    poolSaturationWarnRatio?: number
  }
}
