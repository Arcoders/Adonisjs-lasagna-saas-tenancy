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
 * eager core `/services` barrel and stays safe in a bare unit runner.
 */
export interface CryptoQueryClient {
  rawQuery(sql: string, bindings?: readonly unknown[]): Promise<unknown>
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
 * The Postgres-backed wrapped-DEK store. Like the AI vector store, it NEVER
 * hardcodes a location: it asks the active driver `tableLocation(tenant)`
 * (SEAM-1) where the tenant's wrapped DEKs physically live and runs parameterized
 * raw SQL on that connection with the bare {@link CRYPTO_WRAPPED_DEKS_TABLE}
 * name, which resolves into the tenant schema/database through the connection's
 * search_path. A satellite ContextSeal refuses a query whose tenant differs from
 * the active scope.
 *
 * NOTE (follow-up): `rowscope-pg` is refused for now. Under rowscope the table is
 * shared and needs a `tenant_id` scope column in the migration; adding it (and
 * the scope predicate here) is a bounded later refinement. schema-pg /
 * database-pg / connection are supported today, matching the vector store's
 * staged approach.
 */
export default class PgWrappedDekStore implements WrappedDekStore {
  constructor(private readonly deps: PgWrappedDekStoreDeps) {}

  async findLive(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<WrappedDekRow | null> {
    const { client, table } = await this.#target(tenant)
    // safe-sql: `table` is a fixed module constant; subject/category are ? binds.
    const res = await client.rawQuery(
      `SELECT id, subject_id, category, wrapped_dek, kek_id, shredded_at FROM ${table} ` +
        `WHERE subject_id = ? AND category = ? AND shredded_at IS NULL LIMIT 1`,
      [subjectId, category]
    )
    const row = rowsOf(res)[0]
    return row ? toRow(row) : null
  }

  async listLive(
    tenant: TenantModelContract,
    options: ListLiveOptions = {}
  ): Promise<WrappedDekRow[]> {
    const { client, table } = await this.#target(tenant)
    const limit = normalizeLimit(options.limit)
    // safe-sql: `table` is a fixed module constant; the cursor + limit are ? binds.
    // Keyset on the uuid PK (id > ?), ordered by id, so the walk is bounded-memory
    // and stable under a concurrent re-wrap (a re-wrap keeps the row's id).
    const where =
      options.afterId !== undefined
        ? `WHERE shredded_at IS NULL AND id > ?`
        : `WHERE shredded_at IS NULL`
    const bindings = options.afterId !== undefined ? [options.afterId, limit] : [limit]
    const res = await client.rawQuery(
      `SELECT id, subject_id, category, wrapped_dek, kek_id, shredded_at FROM ${table} ` +
        `${where} ORDER BY id ASC LIMIT ?`,
      bindings
    )
    return rowsOf(res).map(toRow)
  }

  async rewrap(
    tenant: TenantModelContract,
    id: string,
    wrappedDek: string,
    kekId: string
  ): Promise<boolean> {
    const { client, table } = await this.#target(tenant)
    // Only a LIVE row is re-wrapped (WHERE shredded_at IS NULL): a row shredded
    // between the scan and here is a no-op, never resurrecting destroyed key
    // material (I6). The DEK value is unchanged; only its KEK wrapping rotates (I8).
    // safe-sql: `table` is a fixed module constant; every value is a ? bind.
    const res = await client.rawQuery(
      `UPDATE ${table} SET wrapped_dek = ?, kek_id = ? WHERE id = ? AND shredded_at IS NULL`,
      [wrappedDek, kekId, id]
    )
    return rowCount(res) > 0
  }

  async insert(tenant: TenantModelContract, row: NewWrappedDekRow): Promise<WrappedDekRow> {
    const { client, table } = await this.#target(tenant)
    try {
      // safe-sql: `table` is a fixed module constant; every value is a ? bind.
      const res = await client.rawQuery(
        `INSERT INTO ${table} (subject_id, category, wrapped_dek, kek_id) VALUES (?, ?, ?, ?) ` +
          `RETURNING id, subject_id, category, wrapped_dek, kek_id, shredded_at`,
        [row.subjectId, row.category, row.wrappedDek, row.kekId]
      )
      return toRow(rowsOf(res)[0]!)
    } catch (error) {
      // The partial UNIQUE (subject_id, category) WHERE shredded_at IS NULL makes
      // the live DEK singular (I10, T12): a racing second provision is a 23505,
      // surfaced fail-closed so the loser retries and finds the winner's DEK.
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
    const { client, table } = await this.#target(tenant)
    // Tombstone the live row: set shredded_at and null the wrapped DEK, destroying
    // the only copy of the key (I6). Only the live row is touched (WHERE
    // shredded_at IS NULL), so a re-shred is a no-op.
    // safe-sql: `table` is a fixed module constant; subject/category are ? binds.
    const res = await client.rawQuery(
      `UPDATE ${table} SET shredded_at = now(), wrapped_dek = NULL ` +
        `WHERE subject_id = ? AND category = ? AND shredded_at IS NULL`,
      [subjectId, category]
    )
    return rowCount(res) > 0
  }

  /**
   * Resolve the (sealed) tenant connection + table. The satellite ContextSeal
   * comes first (raw SQL bypasses the kernel one), then the driver picks
   * placement; rowscope is refused (see the class note), and the closed union is
   * `assertNever`-exhaustive so a new driver kind is a compile error.
   */
  async #target(
    tenant: TenantModelContract
  ): Promise<{ client: CryptoQueryClient; table: string }> {
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
    switch (location.kind) {
      case 'schema':
      case 'database':
      case 'connection': {
        const db = await this.deps.getDb()
        return { client: db.connection(location.connectionName), table: CRYPTO_WRAPPED_DEKS_TABLE }
      }
      case 'rowscope':
        throw new CryptoException(
          'rowscope_unsupported',
          '[crypto] the wrapped-DEK table under rowscope isolation needs a tenant scope column (a follow-up); use schema-pg or database-pg.'
        )
      default:
        return assertNever(location, 'table location kind')
    }
  }
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
