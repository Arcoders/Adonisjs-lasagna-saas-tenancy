import { PGVECTOR_EXTENSION_SCHEMA } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * Shared pgvector setup for the AI integration specs, kept byte-for-byte in step
 * with how `provisionVectorExtension` sets pgvector up in production: the `vector`
 * type and its operator classes live in the dedicated `PGVECTOR_EXTENSION_SCHEMA`
 * (imported from core, so a rename can't silently drift the specs off production),
 * and every per-tenant connection appends that schema to its search_path. The
 * tenant's own schema stays FIRST, so `ai_embeddings` and every isolation
 * assertion still resolve tenant-first; the shared schema only supplies the bare
 * `vector(N)` type + `vector_cosine_ops`/`<=>` operators that would otherwise be
 * unresolvable from a tenant-only path. `public` is deliberately NOT used (it
 * holds central data in this design).
 */
export { PGVECTOR_EXTENSION_SCHEMA }

interface RawClient {
  rawQuery: (sql: string) => Promise<unknown>
}

/** Install pgvector into the dedicated extensions schema (idempotent). */
export async function ensureVectorExtension(client: RawClient): Promise<void> {
  await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS ${PGVECTOR_EXTENSION_SCHEMA}`)
  await client.rawQuery(
    `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA ${PGVECTOR_EXTENSION_SCHEMA}`
  )
}

/** The tenant-connection search_path that resolves the shared `vector` type. */
export function tenantSearchPath(schema: string): string[] {
  return [schema, PGVECTOR_EXTENSION_SCHEMA]
}
