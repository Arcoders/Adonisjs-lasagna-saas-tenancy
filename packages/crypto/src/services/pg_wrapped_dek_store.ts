import { CRYPTO_WRAPPED_DEKS_TABLE } from '../constants.js'
import { assertNever } from '../internal/assert_never.js'
import CryptoException from '../exceptions/crypto_exception.js'
import { emitCryptoGuardEvent } from '../isthmus/crypto_guard_audit.js'
import type { TableLocation } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { CategoryKey, SubjectId } from '../types/key_provider.js'
import type {
  ListLiveOptions,
  NewWrappedDekRow,
  WrappedDekRow,
  WrappedDekStore,
} from './wrapped_dek_store.js'

/**
 * The minimal Lucid query surface the store uses, injected (via
 * {@link PgWrappedDekStoreDeps.getDb}) so this module never value-imports the
 * eager core `/services` barrel and stays safe in a bare unit runner. `transaction`
 * is used only on the rowscope-with-RLS path, to set the per-transaction GUC the
 * FORCED policy reads (see {@link PgWrappedDekStore.#exec}); a real Lucid client
 * satisfies it, and a test double implements it by running the callback with itself.
 */
export interface CryptoQueryClient {
  rawQuery(sql: string, bindings?: readonly unknown[]): Promise<unknown>
  transaction<T>(callback: (trx: CryptoQueryClient) => Promise<T>): Promise<T>
}

export interface CryptoDb {
  connection(name: string): CryptoQueryClient
}

/** The isolation driver surface the store needs: just placement resolution (SEAM-1). */
export interface CryptoStoreDriver {
  readonly name: string
  tableLocation(tenant: TenantModelContract): TableLocation
}

export interface PgWrappedDekStoreDeps {
  /** Resolve the active isolation driver, for `tableLocation(tenant)` (never a hardcoded schema). */
  getDriver: () => Promise<CryptoStoreDriver>
  /** Resolve the Lucid db manager, for the tenant connection + raw queries. */
  getDb: () => Promise<CryptoDb>
  /**
   * The active tenancy scope id (the satellite ContextSeal). Raw queries bypass
   * the kernel ContextSeal, so the store re-asserts the request tenant equals the
   * active scope before every query. Returns undefined when no scope is bound
   * (e.g. a background job), in which case the caller-supplied tenant is trusted.
   */
  activeScopeTenantId: () => string | undefined
}

/**
 * The rowscope tenant filter. Present only under the `rowscope-pg` driver, where
 * the wrapped-DEK table is SHARED across tenants and separation is a `tenant_id`
 * predicate rather than a per-tenant schema/database. Absent under schema-pg /
 * database-pg / connection, where the connection itself is the boundary.
 */
interface RowScope {
  /**
   * The tenant-discriminator column (`rowScopeColumn`, default `tenant_id`).
   * The driver `assertSafeIdentifier`-checks it before it reaches
   * {@link TableLocation} (driver.ts documents this: every namespace string a
   * variant carries is already validated), so it is safe to interpolate; it is
   * config, never user input.
   */
  readonly column: string
  /** The request tenant id (the ContextSeal already re-asserted it equals the active scope). */
  readonly tenantId: string
  /**
   * The RLS GUC the FORCED policy reads (`location.rlsGuc`), present iff the driver
   * reports `rls: true`. When set, every store query runs inside a transaction that
   * first `set_config(...)`s it, so the store's own raw SQL passes the policy.
   */
  readonly rlsGuc?: string
}

/** The resolved (sealed) connection + table + optional rowscope filter for one operation. */
interface StoreTarget {
  readonly client: CryptoQueryClient
  readonly table: string
  readonly scope?: RowScope
}

/**
 * The Postgres-backed wrapped-DEK store. Like the AI vector store, it NEVER
 * hardcodes a location: it asks the active driver `tableLocation(tenant)`
 * (SEAM-1) where the tenant's wrapped DEKs physically live and runs parameterized
 * raw SQL on that connection with the bare {@link CRYPTO_WRAPPED_DEKS_TABLE}
 * name, which resolves into the tenant schema/database through the connection's
 * search_path. A satellite ContextSeal refuses a query whose tenant differs from
 * the active scope.
 *
 * Placement handling:
 *   - schema-pg / database-pg / connection: the connection IS the tenant boundary,
 *     so the bare table name lands in the tenant's own namespace and no scope
 *     predicate is needed.
 *   - rowscope-pg: the table is SHARED, so every query carries an
 *     `AND <scopeColumn> = ?` predicate (the primary, always-present isolation),
 *     and INSERT stamps the scope column. When the driver reports `rls: true`
 *     (a FORCED RLS policy backstops the column), the store also sets the
 *     transaction-local RLS GUC so its own raw SQL passes the policy. The shared
 *     table + policy ship as the central rowscope migration a host publishes; the
 *     host adds the table to `isolation.rowScopeTables` (crypto cannot self-register
 *     into the boot RLS probe, that list is host config).
 */
export default class PgWrappedDekStore implements WrappedDekStore {
  constructor(private readonly deps: PgWrappedDekStoreDeps) {}

  async findLive(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<WrappedDekRow | null> {
    const target = await this.#target(tenant)
    const { table, scope } = target
    // safe-sql: `table` is a fixed module constant and `scope.column` is a driver-
    // validated config identifier; subject/category/tenant are ? binds.
    const sql =
      `SELECT id, subject_id, category, wrapped_dek, kek_id, shredded_at FROM ${table} ` +
      `WHERE subject_id = ? AND category = ? AND shredded_at IS NULL${scopeSql(scope)} LIMIT 1`
    const bindings = scope ? [subjectId, category, scope.tenantId] : [subjectId, category]
    const res = await this.#exec(target, sql, bindings)
    const row = rowsOf(res)[0]
    return row ? toRow(row) : null
  }

  async listLive(
    tenant: TenantModelContract,
    options: ListLiveOptions = {}
  ): Promise<WrappedDekRow[]> {
    const target = await this.#target(tenant)
    const { table, scope } = target
    const limit = normalizeLimit(options.limit)
    // Keyset on the uuid PK (id > ?), ordered by id, so the walk is bounded-memory
    // and stable under a concurrent re-wrap (a re-wrap keeps the row's id).
    const conds = ['shredded_at IS NULL']
    const bindings: unknown[] = []
    if (options.afterId !== undefined) {
      conds.push('id > ?')
      bindings.push(options.afterId)
    }
    if (scope) {
      conds.push(`${scope.column} = ?`)
      bindings.push(scope.tenantId)
    }
    bindings.push(limit)
    // safe-sql: `table` is a fixed module constant and `scope.column` is a driver-
    // validated config identifier; the cursor + tenant + limit are ? binds.
    const sql =
      `SELECT id, subject_id, category, wrapped_dek, kek_id, shredded_at FROM ${table} ` +
      `WHERE ${conds.join(' AND ')} ORDER BY id ASC LIMIT ?`
    const res = await this.#exec(target, sql, bindings)
    return rowsOf(res).map(toRow)
  }

  async rewrap(
    tenant: TenantModelContract,
    id: string,
    wrappedDek: string,
    kekId: string
  ): Promise<boolean> {
    const target = await this.#target(tenant)
    const { table, scope } = target
    // Only a LIVE row is re-wrapped (WHERE shredded_at IS NULL): a row shredded
    // between the scan and here is a no-op, never resurrecting destroyed key
    // material (I6). The DEK value is unchanged; only its KEK wrapping rotates (I8).
    // safe-sql: `table` is a fixed module constant and `scope.column` is a driver-
    // validated config identifier; every value is a ? bind.
    const sql =
      `UPDATE ${table} SET wrapped_dek = ?, kek_id = ? ` +
      `WHERE id = ? AND shredded_at IS NULL${scopeSql(scope)}`
    const bindings = scope ? [wrappedDek, kekId, id, scope.tenantId] : [wrappedDek, kekId, id]
    const res = await this.#exec(target, sql, bindings)
    return rowCount(res) > 0
  }

  async insert(tenant: TenantModelContract, row: NewWrappedDekRow): Promise<WrappedDekRow> {
    const target = await this.#target(tenant)
    const { table, scope } = target
    // Under rowscope the SHARED table carries the scope column, stamped from the
    // sealed tenant id so a row is owned by exactly one tenant (and the partial
    // UNIQUE is per-(tenant, subject, category)).
    const cols = scope
      ? `(subject_id, category, wrapped_dek, kek_id, ${scope.column})`
      : `(subject_id, category, wrapped_dek, kek_id)`
    const placeholders = scope ? `(?, ?, ?, ?, ?)` : `(?, ?, ?, ?)`
    const bindings = scope
      ? [row.subjectId, row.category, row.wrappedDek, row.kekId, scope.tenantId]
      : [row.subjectId, row.category, row.wrappedDek, row.kekId]
    try {
      // safe-sql: `table` is a fixed module constant and `scope.column` is a driver-
      // validated config identifier; every value is a ? bind.
      const res = await this.#exec(
        target,
        `INSERT INTO ${table} ${cols} VALUES ${placeholders} ` +
          `RETURNING id, subject_id, category, wrapped_dek, kek_id, shredded_at`,
        bindings
      )
      return toRow(rowsOf(res)[0]!)
    } catch (error) {
      // The partial UNIQUE (subject_id, category) WHERE shredded_at IS NULL (or
      // (tenant_id, subject_id, category) under rowscope) makes the live DEK singular
      // (I10, T12): a racing second provision is a 23505, surfaced fail-closed so the
      // loser retries and finds the winner's DEK.
      if (isUniqueViolation(error)) {
        throw new CryptoException(
          'dek_conflict',
          `[crypto] a live DEK already exists for subject '${row.subjectId}' / category '${row.category}'.`
        )
      }
      throw error
    }
  }

  async shredLive(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<boolean> {
    const target = await this.#target(tenant)
    const { table, scope } = target
    // Tombstone the live row: set shredded_at and null the wrapped DEK, destroying
    // the only copy of the key (I6). Only the live row is touched (WHERE
    // shredded_at IS NULL), so a re-shred is a no-op.
    // safe-sql: `table` is a fixed module constant and `scope.column` is a driver-
    // validated config identifier; subject/category/tenant are ? binds.
    const sql =
      `UPDATE ${table} SET shredded_at = now(), wrapped_dek = NULL ` +
      `WHERE subject_id = ? AND category = ? AND shredded_at IS NULL${scopeSql(scope)}`
    const bindings = scope ? [subjectId, category, scope.tenantId] : [subjectId, category]
    const res = await this.#exec(target, sql, bindings)
    return rowCount(res) > 0
  }

  /**
   * Resolve the (sealed) tenant connection + table + optional rowscope filter. The
   * satellite ContextSeal comes first (raw SQL bypasses the kernel one), then the
   * driver picks placement. Every placement is now supported (rowscope carries a
   * scope column instead of a per-tenant namespace), and the closed union is
   * `assertNever`-exhaustive so a new driver kind is a compile error.
   */
  async #target(tenant: TenantModelContract): Promise<StoreTarget> {
    const active = this.deps.activeScopeTenantId()
    if (active !== undefined && active !== tenant.id) {
      // The satellite ContextSeal: raw SQL bypasses the kernel one, so re-assert the
      // request tenant equals the active scope before any query (I4, cross-tenant).
      emitCryptoGuardEvent('guard.crypto_scope_mismatch', { tenantId: tenant.id })
      throw new CryptoException(
        'tenant_scope_mismatch',
        '[crypto] refusing a wrapped-DEK query: the request tenant does not match the active tenancy scope.'
      )
    }

    const driver = await this.deps.getDriver()
    const location = driver.tableLocation(tenant)
    const db = await this.deps.getDb()
    switch (location.kind) {
      case 'schema':
      case 'database':
      case 'connection':
        return { client: db.connection(location.connectionName), table: CRYPTO_WRAPPED_DEKS_TABLE }
      case 'rowscope':
        return {
          client: db.connection(location.connectionName),
          table: CRYPTO_WRAPPED_DEKS_TABLE,
          scope: {
            column: location.scopeColumn,
            tenantId: tenant.id,
            rlsGuc: location.rlsGuc,
          },
        }
      default:
        return assertNever(location, 'table location kind')
    }
  }

  /**
   * Run one store query. On the plain path it is a single `rawQuery`. Under
   * rowscope-with-RLS (`scope.rlsGuc` set) it wraps the query in a transaction that
   * first sets the transaction-local RLS GUC (`is_local = true`), so the store's raw
   * SQL passes a FORCED policy on the shared table without leaking the setting onto
   * the pooled connection. The `set_config` name is bound, never interpolated.
   */
  async #exec(target: StoreTarget, sql: string, bindings: readonly unknown[]): Promise<unknown> {
    const { client, scope } = target
    if (scope?.rlsGuc) {
      const guc = scope.rlsGuc
      return client.transaction(async (trx) => {
        await trx.rawQuery('SELECT set_config(?, ?, true)', [guc, scope.tenantId])
        return trx.rawQuery(sql, bindings)
      })
    }
    return client.rawQuery(sql, bindings)
  }
}

/**
 * The `AND <scopeColumn> = ?` predicate fragment appended under rowscope, empty
 * otherwise. safe-sql: `scope.column` is the driver-validated `rowScopeColumn`
 * (assertSafeIdentifier-checked before it reaches TableLocation), never user input;
 * the value is a ? bind supplied by the caller.
 */
function scopeSql(scope?: RowScope): string {
  return scope ? ` AND ${scope.column} = ?` : ''
}

/** Rows out of a Lucid rawQuery result (pg returns `{ rows }`; a fake may return a bare array). */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown } | unknown[]
  if (r && Array.isArray((r as { rows?: unknown }).rows)) {
    return (r as { rows: Array<Record<string, unknown>> }).rows
  }
  if (Array.isArray(r)) return r as Array<Record<string, unknown>>
  return []
}

/** Affected-row count out of a Lucid rawQuery result. */
function rowCount(result: unknown): number {
  const r = result as { rowCount?: number; rows?: unknown[] }
  if (r && typeof r.rowCount === 'number') return r.rowCount
  if (r && Array.isArray(r.rows)) return r.rows.length
  return 0
}

/** Map a DB row onto the typed {@link WrappedDekRow}. */
function toRow(row: Record<string, unknown>): WrappedDekRow {
  const shredded = row.shredded_at
  return {
    id: String(row.id),
    subjectId: String(row.subject_id),
    category: String(row.category),
    wrappedDek: String(row.wrapped_dek),
    kekId: String(row.kek_id),
    shreddedAt: shredded ? new Date(String(shredded)) : null,
  }
}

/** A Postgres unique-violation (SQLSTATE 23505), however the driver surfaces it. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return code === '23505'
}

/** Clamp the rekek page size to a sane bounded range (default 500). */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return 500
  return Math.min(Math.floor(limit), 1000)
}
