/**
 * Connection + memory introspection for the budget/churn/memory tiers. The
 * pool walk mirrors the doctor's connection_pool_check
 * (packages/core/src/services/doctor/checks/connection_pool_check.ts): read
 * `db.manager.connections`, then each node's `connection.pool.numUsed()/numFree()/max`.
 */

type DbService = any

export interface PoolSnapshot {
  name: string
  numUsed: number
  numFree: number
  numPending: number
  max: number
}

export interface ConnectionSnapshot {
  /** Open tenant connections (name starts with the tenant prefix). */
  tenantOpen: number
  /** All open connections registered in Lucid's manager. */
  totalOpen: number
  pools: PoolSnapshot[]
}

export function snapshotConnections(db: DbService, tenantPrefix = 'tenant_'): ConnectionSnapshot {
  const connections = db.manager.connections
  const pools: PoolSnapshot[] = []
  let tenantOpen = 0
  let totalOpen = 0

  if (connections && typeof connections.entries === 'function') {
    for (const [name, node] of connections) {
      if (node.state !== 'open' || !node.connection) continue
      totalOpen++
      if (name.startsWith(tenantPrefix)) tenantOpen++

      const pool: any = node.connection.pool
      if (!pool || typeof pool.numUsed !== 'function') continue
      const numUsed = Number(pool.numUsed?.() ?? 0)
      const numFree = Number(pool.numFree?.() ?? 0)
      pools.push({
        name,
        numUsed,
        numFree,
        numPending: Number(pool.numPendingAcquires?.() ?? 0),
        max: Number(pool.max ?? numUsed + numFree),
      })
    }
  }

  return { tenantOpen, totalOpen, pools }
}

/** Live backend count for the bench database, the server-side truth to cross-check. */
export async function pgBackendCount(db: DbService): Promise<number> {
  const res = await db.rawQuery(
    'SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database()'
  )
  const rows = Array.isArray(res.rows) ? res.rows : res
  return Number(rows?.[0]?.c ?? 0)
}

/**
 * Live backend count across ALL non-template databases on the server. For
 * `database-pg` each tenant connection lives in its OWN database, so the
 * `current_database()` count above misses them entirely; this counts them.
 * Safe on the dedicated bench server (only bench databases exist there).
 */
export async function pgBackendCountAllDatabases(db: DbService): Promise<number> {
  const res = await db.rawQuery(
    'SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname IS NOT NULL'
  )
  const rows = Array.isArray(res.rows) ? res.rows : res
  return Number(rows?.[0]?.c ?? 0)
}

/**
 * Release every open per-tenant connection from Lucid's manager, so a tier that
 * measures connection counts starts from a clean slate (e.g. churn after the
 * cold-connection phase left dozens registered). The shared rowscope `tenant`
 * connection has no `tenant_` suffix, so it is never touched here.
 */
export async function disconnectAllTenants(db: DbService, tenantPrefix = 'tenant_'): Promise<void> {
  const connections = db.manager.connections
  if (!connections || typeof connections.entries !== 'function') return
  const names: string[] = []
  for (const [name] of connections) {
    if (name.startsWith(tenantPrefix)) names.push(name)
  }
  for (const name of names) {
    if (db.manager.has(name)) await db.manager.release(name)
  }
}

export function memorySnapshot(): { rssMB: number; heapUsedMB: number } {
  const m = process.memoryUsage()
  return {
    rssMB: Math.round((m.rss / 1024 / 1024) * 10) / 10,
    heapUsedMB: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
  }
}
