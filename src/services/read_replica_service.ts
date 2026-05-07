import { createHash } from 'node:crypto'
import { getConfig } from '../config.js'
import type { TenantModelContract } from '../types/contracts.js'
import type { ReadReplicaHost } from '../types/config.js'

const lazyDb = () =>
  import('@adonisjs/lucid/services/db')
    .then((m) => m.default)
    .catch(() => null)

/**
 * Picks a read replica for a tenant according to the configured strategy.
 * Pure for `random`/`round-robin` (in-memory cursor), deterministic for
 * `sticky` (hash of tenantId).
 *
 * Returns `null` when read replicas are not configured — callers should
 * fall back to the primary connection.
 */
export default class ReadReplicaService {
  #cursor = 0

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
      const hash = createHash('sha1').update(tenantId).digest()
      return hash.readUInt32BE(0) % cfg.hosts.length
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
    return getConfig().tenantReadReplicas!.hosts[idx]
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
    const host = cfg.hosts[idx]
    const connName = this.connectionName(tenant.id, idx)

    if (!db.manager.has(connName)) {
      // Ensure the primary tenant connection exists so we can clone its config.
      const { getActiveDriver } = await import('./isolation/active_driver.js')
      const driver = await getActiveDriver()
      await driver.connect(tenant)
      const primaryName = `${getConfig().tenantConnectionNamePrefix}${tenant.id}`
      const primary = (db.manager as any).get?.(primaryName)?.config
        ?? (db as any).getRawConnection?.(primaryName)?.config

      const baseConnection: any = primary?.connection ?? {}
      db.manager.add(connName, {
        client: 'pg',
        connection: {
          ...baseConnection,
          host: host.host,
          port: host.port ?? baseConnection.port,
          user: host.user ?? baseConnection.user,
          password: host.password ?? baseConnection.password,
          searchPath: baseConnection.searchPath ?? tenant.schemaName,
        },
      })
    }

    return db.connection(connName)
  }

  /**
   * Reset the round-robin cursor — mainly useful in tests for determinism.
   */
  resetCursor(): void {
    this.#cursor = 0
  }
}
