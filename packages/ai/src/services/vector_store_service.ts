import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import AIException from '../exceptions/ai_exception.js'
import { assertNever } from '@adonisjs-lasagna/saas-tenancy/sdk'
import { AI_EMBEDDINGS_TABLE } from '../constants.js'
import type { RetrievalScope } from '../define_config.js'
import type { TableLocation } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The minimal Lucid query surface the store uses. Kept narrow (and injected via
 * {@link VectorStoreDeps.getDb}) so this module never value-imports the eager
 * core `/services` barrel and stays safe in a bare unit runner. `rawQuery` is
 * required because pgvector has no Lucid column type.
 */
export interface VectorQueryClient {
  rawQuery(sql: string, bindings?: readonly unknown[]): Promise<unknown>
  transaction<T>(callback: (trx: VectorQueryClient) => Promise<T>): Promise<T>
}

export interface VectorDb {
  connection(name: string): VectorQueryClient
}

/** The isolation driver surface the store needs: just placement resolution (SEAM-1). */
export interface VectorStoreDriver {
  readonly name: string
  tableLocation(tenant: TenantModelContract): TableLocation
}

export interface VectorStoreDeps {
  /** Resolve the active isolation driver, for `tableLocation(tenant)` (never a hardcoded schema). */
  getDriver: () => Promise<VectorStoreDriver>
  /** Resolve the Lucid db manager, for the tenant connection + raw queries. */
  getDb: () => Promise<VectorDb>
  /**
   * The active tenancy scope id (the satellite ContextSeal). Raw queries bypass
   * the kernel ContextSeal, so the store re-asserts the request tenant equals
   * the active scope before every query. Returns undefined when no scope is
   * bound (e.g. a background job), in which case the caller-supplied tenant is
   * trusted.
   */
  activeScopeTenantId: () => string | undefined
  /** The migrated `vector(N)` dimension every stored/queried vector must match. */
  dimension: number
  /**
   * Per-BATCH `statement_timeout` (ms) for the WS-AI-9 batched purge (E4/E21).
   * Bounds a single lock-blocked or runaway batch so it fails cleanly and the
   * loop retries; it is NOT a wall clock on the whole erasure (that must run to
   * completion). Absent ⇒ the connection default applies (no per-batch timeout).
   */
  purgeStatementTimeoutMs?: number | undefined
}

/**
 * Rows deleted per batch in the WS-AI-9 purge loop (E4/E12). A full-tenant or
 * per-actor erasure of a multi-million-row HNSW table cannot be one `DELETE`
 * (a long lock, and a `statement_timeout` would roll it back and delete
 * nothing), so it runs as a `ctid IN (SELECT … LIMIT N)` loop, each batch a
 * short advisory-locked transaction, resumable and uncapped overall.
 */
const PURGE_BATCH_SIZE = 1000

/** One embedding row to store. All rows in a call share a `source` (the document / batch key). */
export interface EmbeddingInput {
  readonly content: string
  readonly contentHash: string
  readonly metadata: Record<string, unknown>
  readonly model: string
  readonly actor: string | null
  readonly embedding: readonly number[]
}

/** A similarity-search query: the model that produced the vector, and the vector itself. */
export interface VectorSearchQuery {
  readonly model: string
  readonly vector: readonly number[]
}

/** One similarity-search hit, nearest first. `distance` is the cosine distance (lower is closer). */
export interface VectorMatch {
  readonly id: string
  readonly content: string
  readonly metadata: unknown
  readonly distance: number
}

/**
 * The per-tenant vector store (WS-AI-3). It NEVER hardcodes a location: it asks
 * the active driver `tableLocation(tenant)` (SEAM-1) where the tenant's
 * embeddings physically live, and runs parameterized raw SQL on that connection
 * with the bare {@link AI_EMBEDDINGS_TABLE} name, which resolves into the tenant
 * schema/database through the connection's search_path. Two structural
 * guarantees back isolation (I1): a satellite ContextSeal (raw SQL bypasses the
 * kernel one) refuses a query whose tenant differs from the active scope, and
 * `rowscope-pg` is refused outright (logical isolation is too weak a placement
 * for inversion-sensitive embeddings). Stateful only through the injected db, so
 * it is a container singleton (never `new`-ed per request).
 */
export default class VectorStoreService {
  constructor(private readonly deps: VectorStoreDeps) {}

  /**
   * Store `chunks` (all under one `source`) idempotently. `ON CONFLICT (source,
   * content_hash) DO NOTHING` makes a re-ingest of identical content a no-op, so
   * a client retry or a concurrent duplicate cannot double-insert. When
   * `maxCount` is finite, the count check and the insert run inside one
   * advisory-locked transaction (#18), so two concurrent ingests cannot both
   * pass a stale count and overshoot the plan limit. Returns the ids of every
   * row (freshly inserted or already present), aligned to `chunks`, plus how
   * many were newly inserted.
   */
  async insert(
    tenant: TenantModelContract,
    source: string,
    chunks: readonly EmbeddingInput[],
    opts: { maxCount?: number } = {}
  ): Promise<{ ids: string[]; inserted: number }> {
    if (chunks.length === 0) return { ids: [], inserted: 0 }
    const { client, table } = await this.#target(tenant)
    for (const chunk of chunks) this.#assertVector(tenant, chunk.embedding)

    const maxCount = opts.maxCount
    return client.transaction(async (trx) => {
      // Serialize only this tenant's count+insert critical section; released at
      // commit. No table lock, no SERIALIZABLE retry storms.
      await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtext(?))', [
        `ai_embeddings_cap:${tenant.id}`,
      ])

      if (maxCount !== undefined && Number.isFinite(maxCount)) {
        // safe-sql: `table` is a fixed module constant; no user input.
        const countRes = await trx.rawQuery(`SELECT count(*)::int AS n FROM ${table}`)
        const current = Number(rowsOf(countRes)[0]?.n ?? 0)
        if (current + chunks.length > maxCount) {
          emitAiGuardEvent('guard.ai_embedding_quota_exhausted', {
            tenantId: tenant.id,
            metadata: { current, requested: chunks.length, limit: maxCount },
          })
          throw new AIException(
            'embedding_quota_exhausted',
            `Refusing to store ${chunks.length} embedding(s): tenant is at ${current}/${maxCount} (plan limit embeddingCount).`
          )
        }
      }

      const valuesSql = chunks.map(() => '(?, ?, ?, ?::jsonb, ?, ?, ?, ?::vector)').join(', ')
      const insertBindings: unknown[] = []
      for (const chunk of chunks) {
        insertBindings.push(
          source,
          chunk.contentHash,
          chunk.content,
          JSON.stringify(chunk.metadata ?? {}),
          chunk.model,
          this.deps.dimension,
          chunk.actor,
          toPgVector(chunk.embedding)
        )
      }
      // safe-sql: `table` is a fixed module constant; every value is a ? bind and the placeholder groups carry no user data.
      const insertRes = await trx.rawQuery(
        `INSERT INTO ${table} (source, content_hash, content, metadata, model, dim, actor, embedding) ` +
          `VALUES ${valuesSql} ON CONFLICT (source, content_hash) DO NOTHING RETURNING content_hash`,
        insertBindings
      )
      const inserted = rowsOf(insertRes).length

      const hashes = chunks.map((chunk) => chunk.contentHash)
      const inPlaceholders = hashes.map(() => '?').join(', ')
      // safe-sql: `table` is a fixed module constant; `source` and every hash are ? binds and the placeholders carry no user data.
      const idRes = await trx.rawQuery(
        `SELECT id, content_hash FROM ${table} WHERE source = ? AND content_hash IN (${inPlaceholders})`,
        [source, ...hashes]
      )
      const idByHash = new Map<string, string>()
      for (const row of rowsOf(idRes)) idByHash.set(String(row.content_hash), String(row.id))
      const ids = chunks
        .map((chunk) => idByHash.get(chunk.contentHash))
        .filter((id): id is string => typeof id === 'string')
      return { ids, inserted }
    })
  }

  /**
   * Nearest `limit` rows for `query`, scoped by (model, dim) so a model swap can
   * never mis-rank, and NARROWED by an optional `filter` (WS-AI-5, G2): the
   * per-user document ACL the retrievalFilter hook resolved. The (model, dim)
   * scope and the tenant placement (I1) are mandatory and always applied; the
   * filter only removes rows a user may not see, it can never widen the corpus.
   * A `sources` allow-list with no entries authorizes zero documents, so the
   * search returns without a query (an empty `IN ()` is not valid SQL, and a read
   * that can match nothing costs nothing).
   */
  async search(
    tenant: TenantModelContract,
    query: VectorSearchQuery,
    opts: { limit: number; filter?: RetrievalScope }
  ): Promise<VectorMatch[]> {
    const filter = opts.filter ?? { kind: 'all' }
    if (filter.kind === 'sources' && filter.sources.length === 0) return []

    const { client, table } = await this.#target(tenant)
    this.#assertVector(tenant, query.vector)
    const vec = toPgVector(query.vector)
    const scope = scopeClause(filter)
    // safe-sql: `table` is a fixed module constant; every value (the query vector, model, dim, the scope-predicate values, limit) is a ? bind and the scope placeholders carry no user data.
    const res = await client.rawQuery(
      `SELECT id, content, metadata, (embedding <=> ?::vector) AS distance FROM ${table} ` +
        `WHERE model = ? AND dim = ?${scope.clause} ORDER BY embedding <=> ?::vector LIMIT ?`,
      [vec, query.model, this.deps.dimension, ...scope.bindings, vec, opts.limit]
    )
    return rowsOf(res).map((row) => ({
      id: String(row.id),
      content: String(row.content),
      metadata: row.metadata,
      distance: Number(row.distance),
    }))
  }

  /** How many embedding rows the tenant currently stores (the #18 gauge source of truth). */
  async count(tenant: TenantModelContract): Promise<number> {
    const { client, table } = await this.#target(tenant)
    // safe-sql: `table` is a fixed module constant; no user input.
    const res = await client.rawQuery(`SELECT count(*)::int AS n FROM ${table}`)
    return Number(rowsOf(res)[0]?.n ?? 0)
  }

  /** How many embeddings a principal ingested: the read-only preview for a per-user purge --dry-run. */
  async countByActor(tenant: TenantModelContract, actorHash: string): Promise<number> {
    const { client, table } = await this.#target(tenant)
    // safe-sql: `table` is a fixed module constant; `actor` is a ? bind.
    const res = await client.rawQuery(`SELECT count(*)::int AS n FROM ${table} WHERE actor = ?`, [
      actorHash,
    ])
    return Number(rowsOf(res)[0]?.n ?? 0)
  }

  /** How many embeddings a document holds: the read-only preview for a per-source purge --dry-run. */
  async countBySource(tenant: TenantModelContract, source: string): Promise<number> {
    const { client, table } = await this.#target(tenant)
    // safe-sql: `table` is a fixed module constant; `source` is a ? bind.
    const res = await client.rawQuery(`SELECT count(*)::int AS n FROM ${table} WHERE source = ?`, [
      source,
    ])
    return Number(rowsOf(res)[0]?.n ?? 0)
  }

  /** Delete every row under `source` (poisoning rollback, #3). Returns the row count removed. */
  async deleteBySource(tenant: TenantModelContract, source: string): Promise<number> {
    const { client, table } = await this.#target(tenant)
    // safe-sql: `table` is a fixed module constant; `source` is a ? bind.
    const res = await client.rawQuery(`DELETE FROM ${table} WHERE source = ?`, [source])
    return rowCount(res)
  }

  /**
   * Delete every embedding for the tenant (the WS-AI-9 tenant-purge seam). Runs
   * as a batched, advisory-locked loop (E4/E12/E15) so a huge index erases in
   * bounded chunks without one long lock or a timeout that would roll the whole
   * thing back. Returns the total rows removed; idempotent, so a retry converges.
   */
  async purgeTenant(tenant: TenantModelContract): Promise<number> {
    return this.#batchedDelete(tenant, { clause: '', bindings: [] })
  }

  /**
   * Delete every embedding a principal ingested (per-user GDPR erasure, WS-AI-9).
   * `actor` is the SHA-256 of the principal (the same one-way hash stored at
   * ingest); the caller hashes the raw principal before calling (E1). Exact `?`
   * equality, batched like {@link purgeTenant}. Returns the total rows removed.
   */
  async deleteByActor(tenant: TenantModelContract, actorHash: string): Promise<number> {
    return this.#batchedDelete(tenant, { clause: ' WHERE actor = ?', bindings: [actorHash] })
  }

  /**
   * The batched-delete engine shared by {@link purgeTenant} and
   * {@link deleteByActor} (E4/E12/E15/E21). Each iteration is one short
   * transaction: take the per-tenant advisory lock (the same key ingestion uses,
   * so a batch never races an insert's cap check), optionally bound the batch
   * with `SET LOCAL statement_timeout`, then delete up to {@link PURGE_BATCH_SIZE}
   * rows by `ctid`. Loops until a batch removes fewer than the limit (the tail).
   */
  async #batchedDelete(
    tenant: TenantModelContract,
    where: { clause: string; bindings: readonly unknown[] }
  ): Promise<number> {
    const { client, table } = await this.#target(tenant)
    const lockArg = `ai_embeddings_cap:${tenant.id}`
    const timeoutMs = this.deps.purgeStatementTimeoutMs
    let total = 0
    for (;;) {
      const removed = await client.transaction(async (trx) => {
        await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtext(?))', [lockArg])
        if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
          // safe-sql: SET LOCAL takes a literal (not a bind); the value is a config integer coerced + clamped at boot.
          await trx.rawQuery(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`)
        }
        // safe-sql: `table` is a fixed constant, the WHERE fragment a fixed literal, LIMIT a numeric constant; values are ? binds.
        const res = await trx.rawQuery(
          `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table}${where.clause} LIMIT ${PURGE_BATCH_SIZE})`,
          [...where.bindings]
        )
        return rowCount(res)
      })
      total += removed
      if (removed < PURGE_BATCH_SIZE) break
    }
    return total
  }

  /**
   * Resolve the (sealed) tenant connection + table for a query. The satellite
   * ContextSeal comes first (raw SQL bypasses the kernel one), then the driver
   * picks placement; rowscope is refused, and the closed union is `assertNever`-
   * exhaustive so a new driver kind is a compile error, never a silent fallback.
   */
  async #target(
    tenant: TenantModelContract
  ): Promise<{ client: VectorQueryClient; table: string }> {
    const active = this.deps.activeScopeTenantId()
    if (active !== undefined && active !== tenant.id) {
      emitAiGuardEvent('guard.ai_scope_mismatch', { tenantId: tenant.id, metadata: { active } })
      throw new AIException(
        'tenant_scope_mismatch',
        'Refusing a vector-store query: the request tenant does not match the active tenancy scope.'
      )
    }

    const driver = await this.deps.getDriver()
    const location = driver.tableLocation(tenant)
    switch (location.kind) {
      case 'schema':
      case 'database':
      case 'connection': {
        const db = await this.deps.getDb()
        return { client: db.connection(location.connectionName), table: AI_EMBEDDINGS_TABLE }
      }
      case 'rowscope':
        emitAiGuardEvent('guard.ai_rowscope_refused', { tenantId: tenant.id })
        throw new AIException(
          'rowscope_unsupported',
          'Refusing to run the vector store under rowscope isolation; embeddings need a physically-isolated driver (schema-pg or database-pg).'
        )
      default:
        return assertNever(location, 'table location kind')
    }
  }

  /** Reject a vector whose length is not the index dimension, or that carries a non-finite value. */
  #assertVector(tenant: TenantModelContract, vector: readonly number[]): void {
    const ok =
      vector.length === this.deps.dimension &&
      vector.every((n) => typeof n === 'number' && Number.isFinite(n))
    if (!ok) {
      emitAiGuardEvent('guard.ai_dimension_mismatch', {
        tenantId: tenant.id,
        metadata: { expected: this.deps.dimension, got: vector.length },
      })
      throw new AIException(
        'dimension_mismatch',
        `Refusing an embedding of length ${vector.length}: the index dimension is ${this.deps.dimension}.`
      )
    }
  }
}

/** pgvector text form: `[a,b,c]`, bound as a string and cast `::vector` at the call site. */
function toPgVector(vector: readonly number[]): string {
  return `[${Array.from(vector).join(',')}]`
}

/**
 * Translate a {@link RetrievalScope} into a parameterized WHERE fragment (WS-AI-5).
 * Every user value is a `?` bind, never interpolated (the no_unsafe_raw_sql
 * guard, and correctness): `sources` is an explicit `IN (?, ?, …)` placeholder
 * list (built like the id-lookup in `insert`), `metadata` a single jsonb
 * containment bind. `all` adds nothing. An empty `sources` list never reaches
 * here (the caller short-circuits it), so `IN ()` cannot be produced.
 */
function scopeClause(filter: RetrievalScope): { clause: string; bindings: unknown[] } {
  switch (filter.kind) {
    case 'all':
      return { clause: '', bindings: [] }
    case 'sources': {
      const placeholders = filter.sources.map(() => '?').join(', ')
      return { clause: ` AND source IN (${placeholders})`, bindings: [...filter.sources] }
    }
    case 'metadata':
      return { clause: ' AND metadata @> ?::jsonb', bindings: [JSON.stringify(filter.match)] }
    default:
      return assertNever(filter, 'retrieval scope kind')
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
