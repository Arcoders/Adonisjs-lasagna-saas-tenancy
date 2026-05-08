import type { DeclarativeHooks } from '../services/hook_registry.js'
import type { TenantModelContract } from './contracts.js'

export type TenantResolverStrategy =
  | 'subdomain'
  | 'header'
  | 'path'
  | 'domain-or-subdomain'
  | 'request-data'

/**
 * Per-strategy configuration the resolvers consume. Optional — the built-in
 * resolvers fall back to sensible defaults when these blocks are absent.
 */
export interface RequestDataResolverConfig {
  /** Query-string key. Default `tenant_id`. */
  queryKey?: string
  /** Request-body key (JSON / form / multipart). Default `tenant_id`. */
  bodyKey?: string
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
}

/**
 * Stripe billing satellite — opt-in via `--with=billing` and declaring
 * `config.billing`. Documented end-to-end in `docs/cookbook/stripe-quotas.md`.
 *
 * Plays platform-mode only in v1 (one Stripe account, tenants are subscribers).
 * Stripe Connect is a v1.1 add-on (`resolveAccount` callback).
 */
export interface BillingConfig {
  /** Reserved for future drivers (`'paddle'`, `'lemonsqueezy'`). v1 only ships `'stripe'`. */
  driver: 'stripe'
  stripe: {
    /** Secret key. Read from `STRIPE_API_KEY`. Boot fails if `sk_live_*` and `NODE_ENV !== 'production'` unless `STRIPE_ALLOW_LIVE_IN_DEV=true`. */
    apiKey: string
    /** Webhook signing secret. Read from `STRIPE_WEBHOOK_SECRET`. */
    webhookSecret: string
    /** Pin Stripe API version. Default `'2025-08-27.basil'`. */
    apiVersion?: string
    /** SDK request timeout in ms. Default 10_000. */
    timeout?: number
    /** SDK network retry attempts. Default 3. */
    maxNetworkRetries?: number
  }
  /** Stripe product (or price) ID → plan name. Plan must exist in `plans.definitions`. */
  products: Record<string, string>
  /** Plan assigned when a subscription is canceled or no mapping is found. Must exist in `plans.definitions`. */
  defaultPlan: string
  webhook?: {
    /** Mount path. Default `'/webhooks/stripe'`. Must be in `config.ignorePaths`. */
    path?: string
    /** BullMQ queue for `ProcessStripeEventJob`. Default `'billing-events'`. */
    queueName?: string
    /** Retention for `stripe_processed_events.completed` rows. Default 90 (Stripe's max retry window). */
    idempotencyTtlDays?: number
    /** Hard-fail webhook delivery from non-Stripe IPs. Default `false`. */
    enforceIpAllowlist?: boolean
    /** CIDR/IP list. Default fetched from Stripe's published ranges (cached 24h). */
    allowedIps?: string[]
  }
  /** Dunning state-machine config — what happens after `invoice.payment_failed` retries. */
  dunning?: {
    /** After this many failed attempts, mark `status='past_due'` and emit `PaymentFailed{final:true}`. Default 3 (matches Stripe Smart Retries). */
    maxAttempts?: number
    /** Action when dunning hits `maxAttempts`. Default `'none'`. */
    action?: 'none' | 'downgrade' | 'block'
    /** Days to wait after `past_due` before applying `action`. Default 0. */
    gracePeriodDays?: number
  }
  /** Send `QuotaWarningMailer` on `TenantQuotaExceeded`. Requires `@adonisjs/mail`. Default `false`. */
  notifyOnQuotaExceeded?: boolean
  /** What to do with the Stripe subscription on tenant hard-delete. Default `'cancel'`. */
  onTenantDelete?: 'cancel' | 'detach' | 'preserve'
  /**
   * Auto-bridge `QuotaService.track` → `stripe.billing.meterEvents.create`.
   * Requires `plans.emitTracked = true`. Each entry maps a quota name to
   * the Stripe meter event name. Reports are batched in-memory and flushed
   * every `batchFlushMs` (default 10_000ms) per (tenant, meter).
   */
  usageMapping?: Record<string, { meterEventName: string; batchFlushMs?: number }>
  observability?: {
    /** Emit Prometheus metrics via MetricsService. Default `true` if MetricsService is active. */
    metrics?: boolean
    /** Redact PII (email, last4, phone, etc.) in logs and audit entries. Default `true`. */
    redactPii?: boolean
  }
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
}

export type IsolationDriverChoice =
  | 'schema-pg'
  | 'database-pg'
  | 'rowscope-pg'
  | 'sqlite-memory'

export interface IsolationConfig {
  /**
   * Which isolation strategy to use. Defaults to `schema-pg` (the v1 default).
   * `database-pg` and `rowscope-pg` will land in subsequent v2 milestones.
   */
  driver: IsolationDriverChoice
  /**
   * For `schema-pg` and `database-pg`: the Lucid connection name whose
   * config is cloned to register tenant connections. Defaults to `'tenant'`.
   */
  templateConnectionName?: string
  /**
   * For `database-pg`: prefix used to name the per-tenant PostgreSQL
   * database (`<prefix><tenantId>`). Defaults to `tenant_`.
   */
  tenantDatabasePrefix?: string
  /**
   * For `rowscope-pg`: the names of tenant-scoped tables in the shared
   * schema. Used by `destroy(tenant)` and `reset(tenant)` to issue
   * `DELETE FROM <table> WHERE tenant_id = ?` per table. Tables not
   * listed here are left untouched.
   */
  rowScopeTables?: string[]
  /**
   * For `rowscope-pg`: name of the column carrying the tenant id. Defaults
   * to `tenant_id`.
   */
  rowScopeColumn?: string
  /**
   * For `rowscope-pg` (or any code using `withTenantScope`): how to behave
   * when a scoped model query runs outside both `tenancy.run()` and
   * `unscoped()`.
   *
   *  - `'strict'` (default): throw. The safe choice — a forgotten
   *    `tenancy.run()` in a job/script becomes a loud failure instead of
   *    a silent cross-tenant query.
   *  - `'allowGlobal'`: log nothing, skip the scope. Backwards-compatible
   *    with code that relied on the v1.x behavior.
   */
  rowScopeMode?: 'strict' | 'allowGlobal'
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

export interface MultitenancyConfig {
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
   */
  resolverChain?: string[]
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
    /** Default session duration (seconds). Default: 3600 (1h). Min 60. */
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
  }
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
  }
  backup: {
    storagePath: string
    metadataTtl: number
    pgConnection: {
      host: string
      port: number
      user: string
      password: string
      database: string
    }
    s3?: {
      enabled: boolean
      bucket: string
      region: string
      endpoint?: string
      accessKeyId: string
      secretAccessKey: string
    }
    retention?: BackupRetentionConfig
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
  plans?: PlansConfig
  /** Optional Stripe billing satellite. See {@link BillingConfig}. */
  billing?: BillingConfig
  tenantReadReplicas?: ReadReplicasConfig
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
    /** Pool utilization (0-1) above which `connection_pool_check` warns. Default 0.9. */
    poolSaturationWarnRatio?: number
  }
}
