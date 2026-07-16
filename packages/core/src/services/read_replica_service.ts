import { createHash } from 'node:crypto'
import { getConfig } from '../config.js'
import type { TenantModelContract } from '../types/contracts.js'
import type { ReadReplicaHost } from '../types/config.js'
import ConnectionLru from './isolation/connection_lru.js'
import { connectionHasActiveQuery } from './isolation/pool_in_use.js'
import { CONFIG_DEFAULTS } from '../config_defaults.js'

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

/**
 * Picks a read replica for a tenant according to the configured strategy.
 * Pure for `random`/`round-robin` (in-memory cursor), deterministic for
 * `sticky` (hash of tenantId).
 *
 * Returns `null` when read replicas are not configured. Callers should
 * fall back to the primary connection.
 *
 * Read-your-writes note: `round-robin` and `random` spread a single tenant's
 * sequential reads across hosts, so a read immediately after a write may hit a
 * lagging replica. Use `sticky` (hash of tenant id maps to one host) when a tenant
 * needs consistent reads, and route read-after-write paths to the primary.
 *
 * Replica connections are created on demand and capped by an in-use-aware LRU
 * (`tenantReadReplicas.maxReplicaConnections`, default 50) so that
 * `tenants * hosts` connections can't grow without bound.
 */
/** Bound on the sticky-hash memo so a huge tenant base can't grow it unbounded. */
const STICKY_HASH_CACHE_MAX = 10_000

/**
 * Routes a tenant's read queries to a configured read replica, selecting a host
 * by the `random`, `round-robin`, or `sticky` (hash of tenant id) strategy.
 * Exposes `pickIndex` and `pickHost` to choose a replica, `connectionName` to
 * build a stable connection name, and `resolve` to lazily create a Lucid
 * connection cloned from the primary tenant config (preserving the top-level
 * search_path) overriding only host and credentials. Returns `null` when no
 * replicas are configured so callers fall back to the primary, and caps live
 * connections with an in-use-aware LRU. `resetCursor` aids test determinism.
 */
export default class ReadReplicaService {
  #cursor = 0
  // Memoized SHA-1 hashed to a uint32 per tenant for the `sticky` strategy. The hash is
  // independent of host count, so we cache the raw 32-bit value and apply the
  // modulo per call, so a host-pool change still routes correctly without
  // re-hashing on every read.
  readonly #stickyHashCache = new Map<string, number>()
  readonly #lru = new ConnectionLru({
    label: 'ReadReplicaService',
    cap: () =>
      getConfig().tenantReadReplicas?.maxReplicaConnections ??
      CONFIG_DEFAULTS.tenantReadReplicas.maxReplicaConnections,
    graceMs: () => getConfig().isolation.evictionGracePeriodMs,
    release: async (name) => {
      const db = await lazyDb()
      if (!db?.manager.has(name)) return true
      // Keep a replica connection that still has a query running (an in-flight
      // analytics read); the LRU retries it once it goes idle. Mirrors the
      // per-tenant driver closures so eviction never severs live work.
      if (connectionHasActiveQuery(db.manager, name)) return false
      await db.manager.release(name)
      return true
    },
  })

  /**
   * Pick the index of the replica to use for this tenant. `null` when no
   * replicas are configured.
   */
  pickIndex(tenantId: string): number | null {
    const cfg = getConfig().tenantReadReplicas
    if (!cfg || cfg.hosts.length === 0) return null

    const strategy = cfg.strategy ?? 'round-robin'

    if (strategy === 'random') {
      return Math.floor(Math.random() * cfg.hosts.length)
    }

    if (strategy === 'sticky') {
      let hash = this.#stickyHashCache.get(tenantId)
      if (hash === undefined) {
        hash = createHash('sha1').update(tenantId).digest().readUInt32BE(0)
        // Simple bound: drop the whole memo when it grows too large rather than
        // tracking per-entry recency. The hash recomputes cheaply on the next miss.
        if (this.#stickyHashCache.size >= STICKY_HASH_CACHE_MAX) this.#stickyHashCache.clear()
        this.#stickyHashCache.set(tenantId, hash)
      }
      return hash % cfg.hosts.length
    }

    // round-robin
    const idx = this.#cursor % cfg.hosts.length
    this.#cursor = (this.#cursor + 1) >>> 0
    return idx
  }

  /**
   * Convenience: return the chosen host config, or `null` when none.
   */
  pickHost(tenantId: string): ReadReplicaHost | null {
    const idx = this.pickIndex(tenantId)
    if (idx === null) return null
    return getConfig().tenantReadReplicas!.hosts[idx]!
  }

  /**
   * Build the read-connection name for a given tenant + replica index.
   * Stable for the same `(tenantId, idx)` pair so connections are reused.
   */
  connectionName(tenantId: string, idx: number): string {
    const cfg = getConfig().tenantReadReplicas
    const suffix = cfg?.connectionSuffix ?? '_read'
    const prefix = getConfig().tenantConnectionNamePrefix
    return `${prefix}${tenantId}${suffix}_${idx}`
  }

  /**
   * Ensure a Lucid connection exists for the chosen replica and return it.
   * Returns `null` when no replicas are configured (caller should fall back
   * to the primary connection from the active isolation driver).
   *
   * The connection is created on demand by cloning the primary tenant
   * connection's pg config, then overriding host/port/credentials with the
   * replica's. The schema search_path is preserved.
   */
  async resolve(tenant: TenantModelContract) {
    const idx = this.pickIndex(tenant.id)
    if (idx === null) return null

    const db = await lazyDb()
    if (!db) return null

    const cfg = getConfig().tenantReadReplicas!
    const host = cfg.hosts[idx]!
    const connName = this.connectionName(tenant.id, idx)

    // If this replica connection was just evicted, wait for its pool to finish
    // draining before deciding it is still registered. Otherwise we would
    // re-adopt a closing pool and queries would fail mid-flight. Mirrors the
    // per-tenant driver connect() path.
    await this.#lru.settlePending(connName)

    if (!db.manager.has(connName)) {
      // Ensure the primary tenant connection exists so we can clone its config.
      const { getActiveDriver } = await import('./isolation/active_driver.js')
      const driver = await getActiveDriver()
      await driver.connect(tenant)
      // Use the driver's own name builder rather than re-deriving it from the
      // prefix: for rowscope-pg the primary connection is the shared central
      // one (not `${prefix}${id}`), so the hand-rolled name would miss the
      // manager and the replica would clone empty config (dropping pool/ssl/
      // searchPath). schema-pg/database-pg/sqlite are unchanged (their builder
      // returns exactly `${prefix}${id}`).
      const primaryName = driver.connectionName(tenant.id)
      const primary: any =
        (db.manager as any).get?.(primaryName)?.config ??
        (db as any).getRawConnection?.(primaryName)?.config

      const baseConnection: any = primary?.connection ?? {}
      // Clone the FULL primary config and override only host/credentials with
      // the replica's. Spreading `primary` carries over pool sizing, ssl,
      // wrapIdentifier, and (critically) the TOP-LEVEL `searchPath`.
      //
      // `searchPath` MUST stay at the top level: knex reads `config.searchPath`,
      // not `config.connection.searchPath`. The previous bug nested it inside
      // `connection`, so it was ignored and every replica read ran against the
      // default `public` search path (the wrong schema for schema-pg).
      //
      // We deliberately do NOT fabricate a searchPath when the primary lacks
      // one: schema-pg's primary always carries `[tenant_<uuid>]` (inherited
      // here), while database-pg's primary intentionally has none (its tenant
      // data lives in the tenant database's own `public` schema). Forcing a
      // schema name would break database-pg replicas.
      db.manager.add(connName, {
        ...(primary ?? {}),
        client: primary?.client ?? 'pg',
        connection: {
          ...baseConnection,
          host: host.host,
          port: host.port ?? baseConnection.port,
          user: host.user ?? baseConnection.user,
          password: host.password ?? baseConnection.password,
        },
      })
      this.#lru.touch(connName)
      this.#lru.evictIfNeeded()
    } else {
      this.#lru.touch(connName)
    }

    return db.connection(connName)
  }

  /**
   * Reset the round-robin cursor. Mainly useful in tests for determinism.
   */
  resetCursor(): void {
    this.#cursor = 0
  }
}
