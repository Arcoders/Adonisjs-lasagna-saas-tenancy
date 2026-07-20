import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import AIException from '../exceptions/ai_exception.js'
import {
  assertNever,
  isDependencyOutageError,
  tokenizeTenantId,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import { AI_EMBEDDINGS_TABLE, AI_EMBEDDING_CONTENT_UNDECRYPTABLE_METRIC } from '../constants.js'
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
  /**
   * Content-at-rest seal/open (Wave 5, GATED). Injected by the provider ONLY when the
   * host selects `encryptContent`/`encryptMetadata` and the crypto peer is installed, so
   * the store stays crypto-primitive-free. Absent ⇒ the columns are plaintext (today's
   * behavior). `seal` produces enc_v2 ciphertext under the per-tenant embeddings DEK
   * before a value is bound into the INSERT; `open` reverses it on the O(limit) rows a
   * search returns. The vector column is NEVER sealed (ANN search needs it).
   */
  sealContent?: ((tenantId: string, plaintext: string) => Promise<string>) | undefined
  openContent?: ((tenantId: string, ciphertext: string) => Promise<string>) | undefined
  /** Seal the `content` column at rest. Default false. Only takes effect with {@link sealContent} wired. */
  encryptContent?: boolean | undefined
  /**
   * Also seal the `metadata` column at rest. Default false. When true, a metadata-scoped
   * retrieval is refused fail-closed (`guard.ai_embedding_metadata_scope_conflict`): the
   * `metadata @> ?::jsonb` containment cannot run over ciphertext.
   */
  encryptMetadata?: boolean | undefined
  /** Best-effort per-tenant metric sink (default MetricsService), for the content-undecryptable search drop (Wave 5). */
  emitMetric?: ((tenantId: string, name: string, value: number) => void) | undefined
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
   * The one boundary every raw DB call funnels through, so a mid-query BACKEND
   * OUTAGE (the pg connection died, the pool is exhausted, the server is shutting
   * down) becomes a single typed, retryable `vector_store_unavailable` (503) instead
   * of an opaque untyped 500 that every caller would otherwise have to map itself. A
   * real query error (bad SQL, a constraint, a domain `AIException` thrown deeper in a
   * transaction) is NOT an outage, so it propagates unchanged. Not a guard trip: an
   * infrastructure outage is not a policy refusal of untrusted input, consistent with
   * the resilience wave.
   */
  async #execOutageGuard<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op()
    } catch (error) {
      if (isDependencyOutageError(error)) {
        throw new AIException(
          'vector_store_unavailable',
          'the AI vector store database is unavailable',
          { cause: error }
        )
      }
      throw error
    }
  }

  /**
   * Funnel one raw query through {@link #execOutageGuard}. Takes a
   * {@link VectorQueryClient}, so it covers BOTH the plain connection and an
   * in-transaction `trx` (both satisfy the interface): every `rawQuery` in this file
   * goes through here, and there is no other raw path.
   */
  #exec(client: VectorQueryClient, sql: string, bindings?: readonly unknown[]): Promise<unknown> {
    return this.#execOutageGuard(() => client.rawQuery(sql, bindings))
  }

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

    // Wave 5: seal content (and, if configured, metadata) BEFORE opening the
    // advisory-locked transaction, so a KeyProvider/KMS round-trip never runs while
    // holding the per-tenant lock. A seal failure fails the ingest CLOSED (typed 503)
    // with nothing written: plaintext must never land in a column declared encrypted.
    // `content_hash` is untouched (it hashed caller plaintext upstream), so dedup holds.
    const sealed = await this.#sealChunks(tenant.id, chunks)
    const metaPlaceholder = this.deps.encryptMetadata === true ? 'to_jsonb(?::text)' : '?::jsonb'

    const maxCount = opts.maxCount
    // The transaction OPENER is guarded too, not just the queries inside it: an
    // outage can strike while acquiring the connection / issuing BEGIN, before the
    // first #exec runs. A domain AIException thrown inside (the embeddingCount cap)
    // is not an outage, so it passes through unchanged.
    return this.#execOutageGuard(() =>
      client.transaction(async (trx) => {
        // Serialize only this tenant's count+insert critical section; released at
        // commit. No table lock, no SERIALIZABLE retry storms.
        await this.#exec(trx, 'SELECT pg_advisory_xact_lock(hashtext(?))', [
          `ai_embeddings_cap:${tenant.id}`,
        ])

        if (maxCount !== undefined && Number.isFinite(maxCount)) {
          // safe-sql: `table` is a fixed module constant; no user input.
          const countRes = await this.#exec(trx, `SELECT count(*)::int AS n FROM ${table}`)
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

        const valuesSql = chunks
          .map(() => `(?, ?, ?, ${metaPlaceholder}, ?, ?, ?, ?::vector)`)
          .join(', ')
        const insertBindings: unknown[] = []
        for (const [i, chunk] of chunks.entries()) {
          insertBindings.push(
            source,
            chunk.contentHash,
            sealed[i]!.content,
            sealed[i]!.metadata,
            chunk.model,
            this.deps.dimension,
            chunk.actor,
            toPgVector(chunk.embedding)
          )
        }
        // safe-sql: `table` is a fixed module constant; every value is a ? bind and the placeholder groups carry no user data.
        const insertRes = await this.#exec(
          trx,
          `INSERT INTO ${table} (source, content_hash, content, metadata, model, dim, actor, embedding) ` +
            `VALUES ${valuesSql} ON CONFLICT (source, content_hash) DO NOTHING RETURNING content_hash`,
          insertBindings
        )
        const inserted = rowsOf(insertRes).length

        const hashes = chunks.map((chunk) => chunk.contentHash)
        const inPlaceholders = hashes.map(() => '?').join(', ')
        // safe-sql: `table` is a fixed module constant; `source` and every hash are ? binds and the placeholders carry no user data.
        const idRes = await this.#exec(
          trx,
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
    )
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
    // Wave 5 HARD CONSTRAINT: a metadata-scoped read cannot run over encrypted metadata
    // (the `metadata @> ?::jsonb` containment has no meaning on ciphertext), so refuse it
    // fail-closed rather than silently return zero rows (a silent wrong answer is worse
    // than a loud refusal).
    if (filter.kind === 'metadata' && this.deps.encryptMetadata === true) {
      emitAiGuardEvent('guard.ai_embedding_metadata_scope_conflict', { tenantId: tenant.id })
      throw new AIException(
        'embedding_metadata_scope_conflict',
        "Refusing a metadata-scoped retrieval: this tenant's embedding metadata is encrypted " +
          'at rest, so a metadata containment filter cannot run. Use a source scope, or do not ' +
          'enable config.ai.embedding.encryptMetadata.'
      )
    }

    const { client, table } = await this.#target(tenant)
    this.#assertVector(tenant, query.vector)
    const vec = toPgVector(query.vector)
    const scope = scopeClause(filter)
    // safe-sql: `table` is a fixed module constant; every value (the query vector, model, dim, the scope-predicate values, limit) is a ? bind and the scope placeholders carry no user data.
    const res = await this.#exec(
      client,
      `SELECT id, content, metadata, (embedding <=> ?::vector) AS distance FROM ${table} ` +
        `WHERE model = ? AND dim = ?${scope.clause} ORDER BY embedding <=> ?::vector LIMIT ?`,
      [vec, query.model, this.deps.dimension, ...scope.bindings, vec, opts.limit]
    )
    return this.#decodeMatches(tenant.id, rowsOf(res))
  }

  /** How many embedding rows the tenant currently stores (the #18 gauge source of truth). */
  async count(tenant: TenantModelContract): Promise<number> {
    const { client, table } = await this.#target(tenant)
    // safe-sql: `table` is a fixed module constant; no user input.
    const res = await this.#exec(client, `SELECT count(*)::int AS n FROM ${table}`)
    return Number(rowsOf(res)[0]?.n ?? 0)
  }

  /** How many embeddings a principal ingested: the read-only preview for a per-user purge --dry-run. */
  async countByActor(tenant: TenantModelContract, actorHash: string): Promise<number> {
    const { client, table } = await this.#target(tenant)
    // safe-sql: `table` is a fixed module constant; `actor` is a ? bind.
    const res = await this.#exec(
      client,
      `SELECT count(*)::int AS n FROM ${table} WHERE actor = ?`,
      [actorHash]
    )
    return Number(rowsOf(res)[0]?.n ?? 0)
  }

  /** How many embeddings a document holds: the read-only preview for a per-source purge --dry-run. */
  async countBySource(tenant: TenantModelContract, source: string): Promise<number> {
    const { client, table } = await this.#target(tenant)
    // safe-sql: `table` is a fixed module constant; `source` is a ? bind.
    const res = await this.#exec(
      client,
      `SELECT count(*)::int AS n FROM ${table} WHERE source = ?`,
      [source]
    )
    return Number(rowsOf(res)[0]?.n ?? 0)
  }

  /** Delete every row under `source` (poisoning rollback, #3). Returns the row count removed. */
  async deleteBySource(tenant: TenantModelContract, source: string): Promise<number> {
    const { client, table } = await this.#target(tenant)
    // safe-sql: `table` is a fixed module constant; `source` is a ? bind.
    const res = await this.#exec(client, `DELETE FROM ${table} WHERE source = ?`, [source])
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
      const removed = await this.#execOutageGuard(() =>
        client.transaction(async (trx) => {
          await this.#exec(trx, 'SELECT pg_advisory_xact_lock(hashtext(?))', [lockArg])
          if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
            // safe-sql: SET LOCAL takes a literal (not a bind); the value is a config integer coerced + clamped at boot.
            await this.#exec(trx, `SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`)
          }
          // safe-sql: `table` is a fixed constant, the WHERE fragment a fixed literal, LIMIT a numeric constant; values are ? binds.
          const res = await this.#exec(
            trx,
            `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table}${where.clause} LIMIT ${PURGE_BATCH_SIZE})`,
            [...where.bindings]
          )
          return rowCount(res)
        })
      )
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
      // `active` is a FOREIGN tenant id; tokenize it so the broadcast event never
      // fans a real cross-tenant id out to plugin listeners.
      emitAiGuardEvent('guard.ai_scope_mismatch', {
        tenantId: tenant.id,
        metadata: { active: tokenizeTenantId(active) },
      })
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

  /**
   * Seal each chunk's content (and metadata, if `encryptMetadata`) at rest under the
   * per-tenant embeddings DEK, returning the exact strings to bind (Wave 5). With no
   * seal wired, or the flags off, it returns caller plaintext / the serialized metadata
   * JSON, byte-identical to before. A seal failure (a KeyProvider/KMS outage) is a typed
   * FAIL-CLOSED 503 covering the whole batch: the ingest writes nothing rather than
   * leaking plaintext into a column the operator declared encrypted.
   */
  async #sealChunks(
    tenantId: string,
    chunks: readonly EmbeddingInput[]
  ): Promise<Array<{ content: string; metadata: string }>> {
    const encContent = this.deps.encryptContent === true
    const encMeta = this.deps.encryptMetadata === true
    const seal = this.deps.sealContent

    // Serialize metadata OUTSIDE the seal try/catch below. A JSON.stringify failure (a
    // BigInt or a cycle in caller metadata) is a permanent caller fault, NOT an at-rest
    // seal outage, so it must keep its prior propagation (an untyped fatal, exactly as
    // before Wave 5) and must never be repackaged as a retryable `embedding_seal_failed`
    // on the default (encryption-off) path.
    const prepared = chunks.map((chunk) => ({
      chunk,
      metaJson: JSON.stringify(chunk.metadata ?? {}),
    }))

    // Default (or no seam wired): plaintext columns, byte-identical to before.
    if (!seal || (!encContent && !encMeta)) {
      return prepared.map(({ chunk, metaJson }) => ({ content: chunk.content, metadata: metaJson }))
    }

    try {
      // Provision the tenant's embeddings DEK ONCE, sequentially, before fanning out. On a
      // tenant's first encrypted ingest every chunk would otherwise provision the same DEK
      // concurrently; crypto's provisioning lock is fail-OPEN, so N concurrent first-time
      // seals race and all but one lose on the partial-UNIQUE (`dek_conflict`), failing the
      // whole batch. One warm sequential seal makes the DEK live so the concurrent seals
      // below only READ it. If a concurrent request won the provision race first, the DEK
      // now exists, so a single retry of the warm-up read succeeds.
      try {
        await seal(tenantId, '')
      } catch (warmupError) {
        if ((warmupError as { code?: string } | null)?.code !== 'dek_conflict') throw warmupError
        await seal(tenantId, '')
      }
      return await Promise.all(
        prepared.map(async ({ chunk, metaJson }) => ({
          content: encContent ? await seal(tenantId, chunk.content) : chunk.content,
          metadata: encMeta ? await seal(tenantId, metaJson) : metaJson,
        }))
      )
    } catch (error) {
      throw new AIException(
        'embedding_seal_failed',
        'the AI embeddings content could not be sealed at rest; the ingest was refused so no plaintext is stored',
        { cause: error }
      )
    }
  }

  /**
   * Map raw search rows to {@link VectorMatch}es, opening any sealed content/metadata
   * under the per-tenant embeddings DEK (Wave 5). Only the O(limit) returned rows are
   * opened (the ANN index scan already ran). FAIL-SAFE: a row whose sealed value will not
   * open (the tenant corpus was shredded, or one row is corrupt) is dropped from the
   * result set with a content-free metric, never a 500 — a shredded-tenant corpus should
   * read empty. With nothing sealed this is a plain identity map (today's behavior).
   */
  async #decodeMatches(
    tenantId: string,
    rows: Array<Record<string, unknown>>
  ): Promise<VectorMatch[]> {
    const encContent = this.deps.encryptContent === true
    const encMeta = this.deps.encryptMetadata === true
    const open = this.deps.openContent
    const out: VectorMatch[] = []
    for (const row of rows) {
      try {
        const content =
          encContent && open ? await open(tenantId, String(row.content)) : String(row.content)
        const metadata =
          encMeta && open ? JSON.parse(await open(tenantId, String(row.metadata))) : row.metadata
        out.push({ id: String(row.id), content, metadata, distance: Number(row.distance) })
      } catch {
        this.deps.emitMetric?.(tenantId, AI_EMBEDDING_CONTENT_UNDECRYPTABLE_METRIC, 1)
      }
    }
    return out
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
