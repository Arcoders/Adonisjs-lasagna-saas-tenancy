import type { IsolationDriverName } from '../../services/isolation/driver.js'

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
   * Lucid connection used for privileged provisioning DDL that the app's
   * request-serving role must NOT be able to run, currently `CREATE EXTENSION`
   * for pgvector (see `tenant:vector:provision` and the `pgvector_extension`
   * doctor check). It should point at a role with the required privilege
   * (superuser or a specifically granted role), kept separate from the app role
   * so the request path stays least-privilege. Defaults to
   * `centralConnectionName`; the app's normal query path never uses it.
   */
  provisionConnectionName?: string
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
   * through `withTenantRls()`. See docs/data-isolation/rowscope-pg.
   *
   * Leave this `false`/unset and the provider logs a one-time WARNING at boot
   * that `rowscope-pg` is running on mixin-only (convention) isolation. Set it
   * to `true` once you have shipped the RLS migration to assert the enforced
   * backstop is present and silence the warning. This is an acknowledgment flag,
   * not a runtime check: it records that you made the call deliberately.
   */
  rowScopeRls?: boolean
  /**
   * For `rowscope-pg` (or any code using `withTenantScope`): how to behave
   * when a scoped model query runs outside both `tenancy.run()` and
   * `unscoped()`.
   *
   *  - `'strict'` (default): throw. The safe choice: a forgotten
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
   * concurrently ACTIVE tenants, not with this number: a burst of N active
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
  /**
   * For `schema-pg`/`database-pg`: an ABSOLUTE upper bound on open tenant
   * connections, the second tier above `maxTenantConnections`. Unset by default
   * (no ceiling).
   *
   * `maxTenantConnections` is a SOFT target: with `enforceConnectionCap: false`
   * (the default) a burst of concurrently-active tenants lets the pool grow past
   * it, trending toward the active-tenant count and, unchecked, toward PostgreSQL
   * `max_connections`. This ceiling is the last-resort backstop: once the pool
   * reaches it, `connect()` refuses a NEW tenant connection with
   * `TenantConnectionLimitException` (HTTP 503) REGARDLESS of `enforceConnectionCap`,
   * so even an availability-favouring deployment can never exhaust the database.
   * It is UNBYPASSABLE: unlike the soft cap, operational paths (provisioning,
   * migrations, seeding) do NOT bypass it, and bulk/parallel operational paths
   * draw from a ceiling-derived `operationalConnectionBudget`, so no path can push
   * the pool past it. Leaving it unset trades that guarantee for availability.
   *
   * Set it generously ABOVE `maxTenantConnections` (headroom for burst) but safely
   * under `max_connections * poolMax`. Leave it unset only if another layer
   * (PgBouncer, `enforceConnectionCap`) already bounds server connections.
   */
  maxTenantConnectionsHardCeiling?: number
  /**
   * For `schema-pg`/`database-pg`: how many connections the bulk/parallel
   * OPERATIONAL paths (the migration worker pool, the warm pool, satellite
   * migration temp clones) may hold open at once. Default 4.
   *
   * Operational work is bursty and must never crowd out request-serving
   * connections, so keep this small. It is a SOFT budget for those paths,
   * additionally clamped at runtime to `maxTenantConnectionsHardCeiling` (when
   * set) so a parallel/warm operation can never push the pool past the absolute
   * ceiling. Request-serving `connect()` calls do not draw from it.
   */
  operationalConnectionBudget?: number
  /**
   * For `schema-pg`/`database-pg`: opt-in connection WARM POOL (F2). Pre-opens
   * connections for a set of OPERATOR-declared hot tenants at boot, so their first
   * request skips the cold-connection cliff (connection registration + physical
   * open) that an idle tenant otherwise pays on its first query.
   *
   * Off unless `enabled: true`. The tenant set is always operator-declared (a
   * static `tenants` list or an authenticated `selectTenants` hook), NEVER derived
   * from request input, so it cannot become an attacker-forced warm DoS. Warming
   * runs through the capped `connect()` (bounded by `operationalConnectionBudget`
   * and refused by the absolute ceiling), and fails closed: a warm failure is
   * logged and skipped, never thrown into a request.
   */
  warmPool?: WarmPoolConfig
  /**
   * For `schema-pg`/`database-pg`: PgBouncer awareness (F3). Detects whether the
   * database is fronted by a connection pooler and, in transaction-pooling mode,
   * confirms the tenant routing path is pooler-safe. Fail-closed: detection never
   * ASSUMES transaction pooling and never RAISES a cap or the ceiling. Off (or
   * `mode: 'off'`) unless configured. See {@link PgBouncerConfig}.
   */
  pgBouncer?: PgBouncerConfig
}

/** Opt-in connection warm pool (F2). See {@link IsolationConfig.warmPool}. */
export interface WarmPoolConfig {
  /** Warm the declared tenants at boot. Off (no-op) unless true. */
  enabled?: boolean
  /**
   * How many connections to pre-open per tenant. Default 1 (enough to erase the
   * cold cliff). Bounded, and the absolute ceiling still caps the total.
   */
  count?: number
  /**
   * The OPERATOR-declared hot tenants to warm, by id. Ignored when `selectTenants`
   * is set. Never populated from request input.
   */
  tenants?: string[]
  /**
   * An authenticated policy hook that returns the tenant ids to warm (an
   * alternative to a static `tenants` list, e.g. "the top N tenants by traffic").
   * Called once at boot, in the app's own context, never per request.
   */
  selectTenants?: () => string[] | Promise<string[]>
}

/** PgBouncer awareness + conservative auto-tune (F3). See {@link IsolationConfig.pgBouncer}. */
export interface PgBouncerConfig {
  /**
   * `'auto'` probes the server and adapts conservatively; `'transaction'` /
   * `'session'` assert a known pooling mode without probing; `'off'` (the default
   * when the block is absent) disables the feature. Detection is FAIL-CLOSED: it
   * never assumes transaction pooling unless confirmed.
   */
  mode?: 'auto' | 'transaction' | 'session' | 'off'
  /**
   * When true, a CONFIRMED transaction-pooling posture may apply a conservative
   * auto-tune (never RAISING a cap or the ceiling beyond the configured values;
   * detection can only confirm or tighten, never loosen). Default false.
   */
  autoTuneCaps?: boolean
}
