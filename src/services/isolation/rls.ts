import { assertSafeIdentifier } from './identifier.js'

/**
 * PostgreSQL Row-Level Security (RLS) helpers for the `rowscope-pg` driver.
 *
 * `withTenantScope` injects `WHERE tenant_id = ?`, but a hand-written top-level
 * `orWhere` can compose a query the mixin cannot retroactively group, leaking
 * another tenant's rows (see docs/data-isolation/rowscope-pg.md). RLS closes
 * that gap at the database: a policy keyed on a per-transaction setting is
 * enforced for EVERY query, regardless of how it is written.
 *
 * The contract is:
 *   1. Run the `enable_rls_tenant_isolation` migration so each scoped table has
 *      a fail-closed policy: `USING (tenant_id::text = current_setting('app.tenant_id', true))`.
 *   2. At the start of each tenant request/job, set that setting on the
 *      connection that will run the queries — `setTenantRlsGuc()` does this.
 *   3. Because the setting is transaction-local, the queries must run on the
 *      SAME transaction. `withTenantRls()` opens one and hands you the `trx`.
 *
 * When the setting is unset, `current_setting('app.tenant_id', true)` is NULL
 * and the predicate matches no rows — a forgotten scope returns nothing instead
 * of leaking. That is the safe failure mode and the whole point of RLS here.
 */

/** Default per-transaction setting the RLS policy reads. */
export const DEFAULT_RLS_GUC = 'app.tenant_id'

/**
 * A PostgreSQL custom setting must be `class.name` (a dotted pair) so the server
 * accepts it without a prior definition in `postgresql.conf`. Validate the shape
 * even though `set_config()` binds the name as a parameter — a malformed name is
 * a config bug we want to surface loudly, not a silent no-op.
 */
const GUC_NAME = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i

/** Anything exposing Lucid's `rawQuery` — a `QueryClient` or a `TransactionClient`. */
export interface RlsQueryRunner {
  rawQuery(sql: string, bindings?: any[]): Promise<unknown>
}

/** Anything that can open a transaction — a Lucid `Database` or `QueryClient`. */
export interface RlsTransactor {
  transaction<R>(callback: (trx: RlsQueryRunner) => Promise<R>): Promise<R>
}

export interface SetTenantRlsGucOptions {
  /** Override the setting name. Defaults to `app.tenant_id`. */
  gucName?: string
  /**
   * When `true` (default) the value is scoped to the current transaction and
   * resets automatically on COMMIT/ROLLBACK — the only pooling-safe choice.
   * Set `false` only for a dedicated, non-pooled connection you manage yourself.
   */
  transactionLocal?: boolean
}

/**
 * Set the `app.tenant_id` setting on `runner` so an RLS policy can enforce
 * tenant isolation. All three arguments are bound parameters of `set_config()`,
 * so neither the tenant id nor the setting name can break out of SQL; the
 * identifier check is defense in depth so a malformed id never becomes the
 * policy predicate.
 *
 * Prefer `withTenantRls()` unless you already hold the transaction the scoped
 * queries will run on.
 */
export async function setTenantRlsGuc(
  runner: RlsQueryRunner,
  tenantId: string,
  options: SetTenantRlsGucOptions = {}
): Promise<void> {
  assertSafeIdentifier(tenantId, 'tenant id')
  const guc = options.gucName ?? DEFAULT_RLS_GUC
  if (!GUC_NAME.test(guc)) {
    throw new Error(
      `Refusing to use unsafe RLS setting name "${guc}". ` +
        `Expected a "class.name" setting such as "app.tenant_id".`
    )
  }
  const isLocal = options.transactionLocal ?? true
  // set_config(setting, value, is_local) — is_local=true keeps it transaction-
  // scoped so it never leaks to the next request that reuses this pooled
  // connection. All three args are bound.
  await runner.rawQuery('select set_config(?, ?, ?)', [guc, tenantId, isLocal])
}

export interface WithTenantRlsOptions {
  /** Lucid connection name. Omit to use the default connection. */
  connectionName?: string
  /** Override the setting name. Defaults to `app.tenant_id`. */
  gucName?: string
  /**
   * Advanced/testing: supply a transaction-capable client (anything with
   * `.transaction(cb)`). Defaults to the Lucid `db` service — the named
   * connection, or the default one when `connectionName` is omitted.
   */
  transactor?: RlsTransactor
}

async function defaultTransactor(connectionName?: string): Promise<RlsTransactor> {
  const { default: db } = await import('@adonisjs/lucid/services/db')
  return (connectionName ? db.connection(connectionName) : db) as unknown as RlsTransactor
}

/**
 * Run `fn` inside a transaction with `app.tenant_id` set for that transaction,
 * so a PostgreSQL RLS policy enforces tenant isolation for every query that
 * runs on the provided `trx` — regardless of query shape.
 *
 * IMPORTANT: pass `trx` to every tenant-scoped query inside `fn` (e.g.
 * `Post.query({ client: trx })` or `model.useTransaction(trx)`). A query that
 * ignores `trx` runs on a different pooled connection where the setting is not
 * set, so RLS (fail-closed) returns zero rows for it — no leak, but no data
 * either. This is the deliberate trade for shape-independent isolation.
 *
 * @example
 *   await withTenantRls(tenant.id, async (trx) => {
 *     return Post.query({ client: trx }).where('a', 1).orWhere('featured', true)
 *     // RLS still scopes the orWhere branch to the active tenant.
 *   })
 */
export async function withTenantRls<T>(
  tenantId: string,
  fn: (trx: RlsQueryRunner) => T | Promise<T>,
  options: WithTenantRlsOptions = {}
): Promise<T> {
  const transactor = options.transactor ?? (await defaultTransactor(options.connectionName))
  return transactor.transaction(async (trx) => {
    await setTenantRlsGuc(trx, tenantId, { gucName: options.gucName, transactionLocal: true })
    return fn(trx)
  })
}
