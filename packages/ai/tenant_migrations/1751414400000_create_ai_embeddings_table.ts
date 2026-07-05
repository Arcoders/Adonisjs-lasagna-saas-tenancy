import { BaseSchema } from '@adonisjs/lucid/schema'
import { AI_EMBEDDINGS_TABLE, DEFAULT_EMBEDDING_DIM, MAX_EMBEDDING_DIM } from '../src/constants.js'

/**
 * The per-tenant embeddings table (WS-AI-3, SEAM-2, invariant I1). It is a
 * RUNNABLE per-tenant migration (not a backoffice `.stub`): `tenant:migrate`
 * discovers it via the package's `perTenantMigrations` manifest entry and folds
 * it into the run, so it executes into whatever schema/database the active
 * isolation driver reports. There is NO `withSchema('backoffice')` and NO
 * `tenant_<id>` interpolation: the bare table name lands in the tenant's own
 * placement through the tenant connection's search_path.
 *
 * The `vector` extension must already exist where this runs (a privileged
 * provisioning step, G14): centrally for schema-pg/rowscope, or per tenant DB
 * for database-pg via the satellite's `after:provision` hook. The dimension is
 * read from `config.ai.embedding.dimension` at migrate time (deploy-time fixed),
 * so a model whose dimension differs needs a new migration rather than silently
 * corrupting retrieval. Provenance columns (`source`, `actor`, `created_at`)
 * make a poisoned batch identifiable and rollback-by-source possible (#3), and
 * `UNIQUE(source, content_hash)` makes ingestion idempotent under concurrency.
 */
export default class extends BaseSchema {
  async up() {
    const dim = await resolveEmbeddingDim()
    const table = AI_EMBEDDINGS_TABLE

    // safe-sql: `table` is a fixed module constant and `dim` is a config integer validated 1..2000 here; neither is user input, and a column dimension cannot be a bind parameter.
    this.schema.raw(`
      CREATE TABLE ${table} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        content text NOT NULL,
        content_hash char(64) NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        model text NOT NULL,
        dim integer NOT NULL,
        source text NOT NULL,
        actor text,
        embedding vector(${dim}) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (source, content_hash)
      )
    `)

    // The hnsw index builds incrementally, so it is correct on a per-tenant table
    // that starts empty (ivfflat would need a populated table for good centroids).
    // safe-sql: `table` is a fixed module constant; the index method and operator class are literals.
    this.schema.raw(
      `CREATE INDEX ${table}_embedding_hnsw ON ${table} USING hnsw (embedding vector_cosine_ops)`
    )
    // The read filter is always scoped by (model, dim), the dimension-binding surface.
    // safe-sql: `table` is a fixed module constant; no user input.
    this.schema.raw(`CREATE INDEX ${table}_model_dim ON ${table} (model, dim)`)
    // Per-user GDPR erasure (WS-AI-9 `deleteByActor`) filters by `actor` (a SHA-256
    // of the principal). A partial index keeps the common actor-null rows out of it,
    // so the erasure delete is an index scan, not a seq scan (E11).
    // safe-sql: `table` is a fixed module constant; no user input.
    this.schema.raw(`CREATE INDEX ${table}_actor ON ${table} (actor) WHERE actor IS NOT NULL`)
  }

  async down() {
    // safe-sql: `table` is a fixed module constant; no user input.
    this.schema.raw(`DROP TABLE IF EXISTS ${AI_EMBEDDINGS_TABLE}`)
  }
}

/**
 * The configured embedding dimension, validated to pgvector's indexable range.
 * `getConfig` is imported lazily so this module loads without a booted app (it
 * is only ever executed by the migrator inside a running app, where the config
 * is present).
 */
async function resolveEmbeddingDim(): Promise<number> {
  const { getConfig } = await import('@adonisjs-lasagna/saas-tenancy')
  const configured = getConfig().ai?.embedding?.dimension
  const dim =
    typeof configured === 'number' && Number.isInteger(configured)
      ? configured
      : DEFAULT_EMBEDDING_DIM
  if (dim < 1 || dim > MAX_EMBEDDING_DIM) {
    throw new Error(
      `ai embeddings dimension must be an integer in 1..${MAX_EMBEDDING_DIM} (pgvector limit), got ${dim}`
    )
  }
  return dim
}
