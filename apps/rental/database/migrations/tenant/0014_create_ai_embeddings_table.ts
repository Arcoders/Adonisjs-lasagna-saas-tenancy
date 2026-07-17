import { BaseSchema } from '@adonisjs/lucid/schema'
import multitenancyConfig from '#config/multitenancy'

/**
 * The AI satellite's per-tenant vector store, materialised here as an app-owned
 * tenant migration (the satellite's `perTenantMigrations` fold does not fire
 * under workspace hoisting — see the crypto DEK migration for the same note).
 *
 * `vector(N)` requires the pgvector extension to already exist on the tenant
 * connection's search_path (provisioned into the `extensions` schema at setup).
 * The dimension is read from `config.ai.embedding.dimension` so it stays in
 * lockstep with the mock/real embedding provider. DDL mirrors the satellite's.
 */
const AI_EMBEDDINGS_TABLE = 'ai_embeddings'

export default class extends BaseSchema {
  async up() {
    const dim = multitenancyConfig.ai.embedding.dimension
    const table = AI_EMBEDDINGS_TABLE
    // safe-sql: `table` is a fixed literal and `dim` is a config integer; a
    // column dimension cannot be a bind parameter.
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
    this.schema.raw(
      `CREATE INDEX ${table}_embedding_hnsw ON ${table} USING hnsw (embedding vector_cosine_ops)`
    )
    this.schema.raw(`CREATE INDEX ${table}_model_dim ON ${table} (model, dim)`)
    this.schema.raw(`CREATE INDEX ${table}_actor ON ${table} (actor) WHERE actor IS NOT NULL`)
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${AI_EMBEDDINGS_TABLE}`)
  }
}
