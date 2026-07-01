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
