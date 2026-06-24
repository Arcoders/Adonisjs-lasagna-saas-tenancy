import type { HttpContext } from '@adonisjs/core/http'
import type { DeclarativeHooks } from '../services/hook_registry.js'
import type { IsolationDriverName } from '../services/isolation/driver.js'
import type { TenantModelContract } from './contracts.js'

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
}

/**
 * The shipped billing driver names. `(string & {})` keeps autocomplete for the
 * built-ins while admitting a custom driver a host registers on
 * `BillingDriverRegistry`. Kept inline (not imported from `@adonisjs-lasagna/billing`)
 * so core has no dependency on the billing satellite.
 */
export type BillingDriverChoice = 'stripe' | 'paddle' | 'lemonsqueezy' | (string & {})

/**
 * Billing satellite — opt-in via `--with=billing` and declaring `config.billing`.
 * Provider-agnostic: pick `driver` and fill in the matching config block.
 * Documented end-to-end in `docs/cookbook/stripe-quotas.md`.
 *
 * Plays platform-mode only (one provider account, tenants are subscribers).
 */
export interface BillingConfig {
  /**
   * Which billing provider to use. The matching config block below
   * (`stripe` / `paddle` / `lemonSqueezy`) must be present; the driver's
   * `verifyConfig()` validates it at boot.
   */
  driver: BillingDriverChoice
  /** Stripe driver config. Required when `driver: 'stripe'`. */
  stripe?: {
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
  /** Paddle Billing driver config. Required when `driver: 'paddle'`. */
  paddle?: {
    /** API key. Read from `PADDLE_API_KEY`. */
    apiKey: string
    /** Webhook signing secret (`Paddle-Signature`). Read from `PADDLE_WEBHOOK_SECRET`. */
    webhookSecret: string
    /** `'sandbox'` (default) or `'production'`. */
    environment?: 'sandbox' | 'production'
  }
  /** Lemon Squeezy driver config. Required when `driver: 'lemonsqueezy'`. */
  lemonSqueezy?: {
    /** API key. Read from `LEMONSQUEEZY_API_KEY`. */
    apiKey: string
    /** Webhook signing secret (`X-Signature`). Read from `LEMONSQUEEZY_WEBHOOK_SECRET`. */
    webhookSecret: string
    /** Store id checkouts are created against. Read from `LEMONSQUEEZY_STORE_ID`. */
    storeId: string
  }
  /** Provider product (or price/variant) ID → plan name. Plan must exist in `plans.definitions`. */
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
    /**
     * Action when dunning hits `maxAttempts`. Default `'none'`.
     *
     *   - `'none'`: only emit `PaymentFailed{final:true}`. The host's
     *     listener decides what to do (downgrade, send email, block).
     *   - `'downgrade'`: in addition to the event, immediately reassign
     *     the tenant to `defaultPlan` via `QuotaService.assignPlan`.
     *     The Stripe subscription (and the local mirror's `planName`)
     *     stay on the upgraded plan; only the enforced quota drops.
     *     A successful retry that lands `customer.subscription.updated
     *     (active)` re-resolves the original product mapping and
     *     restores the upgraded plan automatically.
     */
    action?: 'none' | 'downgrade'
    /**
     * Days to wait after `past_due` before applying `action`. Default 0
     * (apply immediately). When `> 0`, the downgrade is scheduled and applied
     * by `tenant:billing:sweep` once the window elapses — so run that command
     * on a cron (hourly suggested) if you set a grace period.
     */
    gracePeriodDays?: number
  }
  /**
   * Days before `trial_end` to emit `TrialEnding`. Default 3. Stripe fires a
   * native `trial_will_end` webhook ~3 days out; for Paddle/Lemon Squeezy (no
   * such webhook) `tenant:billing:sweep` synthesises the notice from this
   * lead time. Each subscription is notified exactly once across providers.
   */
  trialEndingLeadDays?: number
  /** Send `QuotaWarningMailer` on `TenantQuotaExceeded`. Requires `@adonisjs/mail`. Default `false`. */
  notifyOnQuotaExceeded?: boolean
  /**
   * Auto-suspend a tenant when a terminal payment failure fires
   * (`PaymentFailed` with `final: true`, or `SubscriptionCanceled` with
   * `reason: 'dunning_failed'`). Blocks all API access until recovery or manual
   * reactivation, and dispatches `TenantSuspended` for cache invalidation.
   * Opt-in. Default `false`.
   */
  suspendOnPaymentFailure?: boolean
  /**
   * When `suspendOnPaymentFailure` is true, auto-reactivate a suspended tenant
   * on `PaymentSucceeded` (transition back to `active`, dispatch
   * `TenantActivated`). Ignored unless `suspendOnPaymentFailure` is true.
   * Opt-in. Default `false`.
   */
  reactivateOnPaymentSuccess?: boolean
  /** What to do with the provider subscription on tenant hard-delete. Default `'cancel'`. */
  onTenantDelete?: 'cancel' | 'detach' | 'preserve'
  /**
   * Auto-bridge `QuotaService.track` → the active driver's usage metering.
   * Requires `plans.emitTracked = true` and a driver that supports
   * `usage_metering`. Each entry maps a quota name to the provider meter event
   * name. Reports are batched in-memory and flushed every `batchFlushMs`
   * (default 10_000ms) per (tenant, meter).
   */
  usageMapping?: Record<string, { meterEventName: string; batchFlushMs?: number }>
  observability?: {
    /** Emit Prometheus metrics via MetricsService. Default `true` if MetricsService is active. */
    metrics?: boolean
    /** Redact PII (email, last4, phone, etc.) in logs and audit entries. Default `true`. */
    redactPii?: boolean
  }
  /**
   * Opt-in fiscal features (multi-country tax snapshots + an append-only invoice
   * read model). The DDL is published separately at configure time
   * (`node ace configure @adonisjs-lasagna/billing` → answer yes, or
   * `LASAGNA_BILLING_FISCAL=1`); this block gates the runtime behaviour. The
   * provider stays the source of truth for tax and invoices — we only record
   * snapshots for reporting/reconciliation (no local invoice numbering, no tax
   * engine). Disabled when absent.
   */
  fiscal?: {
    /**
     * Master switch for the fiscal runtime behaviour: capturing the provider's
     * tax breakdown onto payment events / the ledger, writing the
     * `billing_invoice_snapshots` read model, and mounting the invoice
     * read-through routes. Default `false`.
     */
    enabled?: boolean
    /**
     * Pass Stripe `automatic_tax: { enabled: true }` at checkout so the provider
     * computes tax. The provider does the math; we only snapshot the result.
     * Default `false`.
     */
    automaticTax?: boolean
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
  /**
   * Max replica connections kept open in Lucid's manager before the oldest
   * IDLE one is evicted. Replica connections multiply by host
   * (`tenants * hosts`), so this is a separate budget from
   * `isolation.maxTenantConnections`. Default 50. The same in-use grace window
   * applies, so an in-flight read is never severed.
   */
  maxReplicaConnections?: number
}

/**
 * The shipped drivers plus any custom driver name registered through
 * `IsolationDriverRegistry`. Aliases the driver contract's own name type so
 * the two unions cannot drift apart.
 */
export type IsolationDriverChoice = IsolationDriverName

export interface IsolationConfig {
  /**
   * Which isolation strategy to use. Defaults to `schema-pg`. All four drivers
   * (`schema-pg`, `database-pg`, `rowscope-pg`, `sqlite-memory`) are
   * implemented and selectable.
   */
  driver: IsolationDriverChoice
  /**
   * For `schema-pg` and `database-pg`: the Lucid connection name whose
   * config is cloned to register tenant connections. Defaults to `'tenant'`.
   * `rowscope-pg` ignores this and shares `centralConnectionName` (it has no
   * per-tenant connection to clone).
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
   * For `rowscope-pg`: assert that the SQL-level Row-Level Security backstop is
   * in place. With `rowscope-pg`, the `withTenantScope` mixin adds
   * `WHERE tenant_id = ?`, but a hand-written top-level `orWhere` can compose a
   * query the mixin cannot retroactively group and leak another tenant's rows.
   * The fix is the `enable_rls_tenant_isolation` migration plus routing writes
   * through `withTenantRls()` — see docs/data-isolation/rowscope-pg.
   *
   * Leave this `false`/unset and the provider logs a one-time WARNING at boot
   * that `rowscope-pg` is running on mixin-only (convention) isolation. Set it
   * to `true` once you have shipped the RLS migration to assert the enforced
   * backstop is present and silence the warning. This is an acknowledgment flag,
   * not a runtime check — it records that you made the call deliberately.
   */
  rowScopeRls?: boolean
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
  /**
   * For `schema-pg` and `database-pg`: how many tenant connections may stay
   * open in Lucid's manager before the LRU evicts the oldest IDLE one.
   * Default 50. Each tenant connection holds its own pool, so keep this under
   * your PostgreSQL `max_connections` budget (roughly
   * `maxTenantConnections * poolMax` server connections). The LRU never evicts
   * a connection used within `evictionGracePeriodMs`.
   *
   * SIZING WARNING: this is a SOFT cap by default. Open connections scale with
   * concurrently ACTIVE tenants, not with this number — a burst of N active
   * tenants opens ~N pools (none are evictable inside the grace window), and
   * exhausting PostgreSQL `max_connections` takes down the whole database, not
   * just the burst. Size `max_connections` for your peak concurrent-tenant
   * count, front Postgres with PgBouncer at higher tenant counts, and see
   * `enforceConnectionCap` for the hard-bound trade-off. Full guidance:
   * docs "Scaling limits".
   */
  maxTenantConnections?: number
  /**
   * For `schema-pg`/`database-pg`: a tenant connection touched more recently
   * than this (ms) is treated as in-use and is never evicted, even when over
   * `maxTenantConnections`. Set comfortably above your p99 request duration so
   * an in-flight request is never severed. Default 30000.
   */
  evictionGracePeriodMs?: number
  /**
   * For `schema-pg`/`database-pg`: turn `maxTenantConnections` into a HARD cap.
   *
   * By default (`false`) the in-use-aware LRU favours availability: when the cap
   * is reached and every open connection is still inside `evictionGracePeriodMs`
   * (so none can be evicted without severing an in-flight request), it lets the
   * pool exceed the cap and warns. Under a burst of more than `maxTenantConnections`
   * concurrently-active tenants, open connections therefore trend toward the
   * number of active tenants, not the cap.
   *
   * Set this to `true` to favour a bounded server-connection budget instead:
   * `connect()` then refuses a NEW tenant connection in that situation and
   * throws `TenantConnectionLimitException` (HTTP 503), rather than exceeding the
   * cap. Recommended when you front PostgreSQL with PgBouncer or must keep server
   * connections strictly under `max_connections`. Default false.
   */
  enforceConnectionCap?: boolean
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

/** How a subsystem behaves when a backing dependency (Redis/PG/…) errors. */
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
  /**
   * Optional backup config block. Consumed only by the extracted
   * `@adonisjs-lasagna/backup` satellite (the core never reads it). Apps that
   * don't install that package can omit this entirely; the satellite throws a
   * clear error at call time if a backup operation runs without it configured.
   */
  backup?: {
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
    /**
     * When the Redis coordination layer is unreachable, the destructive
     * operations (restore / clone / import) fail closed by default: they refuse
     * to run unserialised rather than risk corrupting a schema. Set this `true`
     * to opt them back into the legacy fail-open behaviour (proceed without the
     * lock). The read-only `backup` always fails open regardless of this flag.
     */
    lockFailOpenOnDestructive?: boolean
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
