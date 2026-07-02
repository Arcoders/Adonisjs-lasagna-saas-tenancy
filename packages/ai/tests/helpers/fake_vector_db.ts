import type { TableLocation } from '@adonisjs-lasagna/saas-tenancy/services'
import type {
  VectorDb,
  VectorQueryClient,
  VectorStoreDeps,
} from '../../src/services/vector_store_service.js'

export interface FakeVectorEnvOptions {
  /** The placement the fake driver reports. Default `'schema'`. */
  kind?: 'schema' | 'database' | 'rowscope' | 'connection'
  /** The migrated dimension. Default 8. */
  dimension?: number
  /** What `SELECT count(*)` returns. Default 0. */
  count?: number
  /** The active tenancy scope id (the ContextSeal). Default undefined (seal passes). */
  activeScope?: string
  /** Rows the id-lookup SELECT returns ({ id, content_hash }). Default []. */
  existing?: Array<{ id: string; content_hash: string }>
  /** Rows the INSERT ... RETURNING returns (newly inserted). Default []. */
  insertedHashes?: string[]
  /** Affected rows a DELETE reports. Default 0. */
  deleted?: number
}

export interface FakeVectorEnv {
  deps: VectorStoreDeps
  queries: Array<{ sql: string; bindings: readonly unknown[] }>
  connections: string[]
}

function buildLocation(kind: NonNullable<FakeVectorEnvOptions['kind']>): TableLocation {
  switch (kind) {
    case 'schema':
      return { kind: 'schema', schema: 'tenant_fake', connectionName: 'tenant_conn' }
    case 'database':
      return { kind: 'database', database: 'tenant_fake', connectionName: 'tenant_conn' }
    case 'connection':
      return { kind: 'connection', connectionName: 'tenant_conn' }
    case 'rowscope':
      return { kind: 'rowscope', scopeColumn: 'tenant_id', rls: false, connectionName: 'central' }
  }
}

/**
 * A fake Lucid db + isolation driver for VectorStoreService unit tests. It
 * records every raw query and connection name, and answers by SQL shape (count,
 * id-lookup, insert-returning, delete), so the store's guards, SQL shape and
 * driver dispatch are exercised without a real Postgres.
 */
export function fakeVectorEnv(opts: FakeVectorEnvOptions = {}): FakeVectorEnv {
  const dimension = opts.dimension ?? 8
  const queries: FakeVectorEnv['queries'] = []
  const connections: string[] = []

  const client: VectorQueryClient = {
    async rawQuery(sql, bindings = []) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), bindings })
      const s = sql.toLowerCase()
      if (s.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (s.includes('count(*)')) return { rows: [{ n: opts.count ?? 0 }] }
      if (s.includes('insert into'))
        return { rows: (opts.insertedHashes ?? []).map((content_hash) => ({ content_hash })) }
      if (s.startsWith('select id')) return { rows: opts.existing ?? [] }
      if (s.startsWith('delete')) return { rowCount: opts.deleted ?? 0 }
      return { rows: [] }
    },
    async transaction(callback) {
      return callback(client)
    },
  }

  const db: VectorDb = {
    connection(name) {
      connections.push(name)
      return client
    },
  }

  const deps: VectorStoreDeps = {
    getDriver: async () => ({
      name: `${opts.kind ?? 'schema'}-pg`,
      tableLocation: () => buildLocation(opts.kind ?? 'schema'),
    }),
    getDb: async () => db,
    activeScopeTenantId: () => opts.activeScope,
    dimension,
  }

  return { deps, queries, connections }
}

/** A deterministic finite vector of the given length (for store specs). */
export function vec(length: number, seed = 1): number[] {
  return Array.from({ length }, (_, i) => (seed + i) / (length + seed))
}
