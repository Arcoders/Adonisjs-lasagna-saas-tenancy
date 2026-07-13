import type { Database } from '@adonisjs/lucid/database'
import type { ConnectionManagerContract, QueryClientContract } from '@adonisjs/lucid/types/database'
import { getConfig } from '../../config.js'
import type { TenantModelContract } from '../../types/contracts.js'
import type { PluginReadOnlyConfig } from '../../types/config.js'
import { ISOLATION_CONTRACT_VERSION } from './driver.js'
import type {
  DestroyOptions,
  IsolationDriverName,
  MigrateOptions,
  MigrateResult,
  ProvisionableDriver,
  TableLocation,
} from './driver.js'
import { assertSafeIdentifier } from '../../isthmus/guarded_identifier.js'
import { runTenantMigrations } from './tenant_migration_runner.js'
import TenantConnectionLimitException from '../../exceptions/tenant_connection_limit_exception.js'
import IsolationConfigException from '../../exceptions/isolation_config_exception.js'
import ConnectionLru from './connection_lru.js'
import { connectionHasActiveQuery } from './pool_in_use.js'
import {
  buildReadOnlyConnectionConfig,
  READ_ONLY_CONNECTION_SUFFIX,
} from '../plugin_read_only_connection.js'

/**
 * Shared base for the two PostgreSQL drivers that own a per-tenant Lucid
 * connection pool: `schema-pg` (one schema per tenant) and `database-pg` (one
 * database per tenant). Everything that is IDENTICAL between them lives here —
 * the bounded, in-use-aware {@link ConnectionLru}, the connect/disconnect/
 * markUsed/migrate flow, the hard-cap admission check, and the cached-connection
 * identity seal — so `markUsed`, the eviction/settle race handling, and the
 * firewall against re-adopting a draining pool are implemented ONCE.
 *
 * A subclass supplies only what genuinely differs, through two hooks plus its
 * own DDL:
 *   - {@link buildTenantConfig}: turn the template connection config into this
 *     tenant's config (schema-pg sets `searchPath`, database-pg overrides
 *     `connection.database`).
 *   - {@link verifyCachedConnection}: the identity seal — assert a cached
 *     connection is still pinned to THIS tenant before serving it (schema-pg
 *     keys on `searchPath`, database-pg on `connection.database`).
 * plus `provision` / `destroy` / `reset` / `tableLocation` / `name`.
 */
export default abstract class PooledPgDriver implements ProvisionableDriver {
  abstract readonly name: IsolationDriverName
  readonly contractVersion = ISOLATION_CONTRACT_VERSION
  protected readonly templateConnectionName: string
  readonly #label: string
  readonly #lru: ConnectionLru

  constructor(opts: { templateConnectionName?: string | undefined; label: string }) {
    this.templateConnectionName = opts.templateConnectionName ?? 'tenant'
    this.#label = opts.label
    this.#lru = new ConnectionLru({
      label: opts.label,
      cap: () => getConfig().isolation.maxTenantConnections,
      graceMs: () => getConfig().isolation.evictionGracePeriodMs,
      hardCap: () => getConfig().isolation.enforceConnectionCap ?? false,
      hardCeiling: () => getConfig().isolation.maxTenantConnectionsHardCeiling,
      release: async (name) => {
        const { db } = await this.lucid()
        if (!db.manager.has(name)) return true
        // Keep a connection that still has a query running; the LRU will retry it
        // once it goes idle.
        if (connectionHasActiveQuery(db.manager, name)) return false
        await db.manager.release(name)
        return true
      },
    })
  }

  /**
   * Lazily resolve `db` so unit tests that only exercise pure helpers
   * (connectionName/schemaName/databaseName) don't drag the Lucid runtime, nor
   * the `await app.booted(...)` inside `@adonisjs/lucid/services/db`, into the
   * test process. Read replicas use the same pattern.
   */
  protected async lucid() {
    const { default: db } = await import('@adonisjs/lucid/services/db')
    return { db }
  }

  connectionName(tenantId: string): string {
    assertSafeIdentifier(tenantId, 'tenant id')
    return `${getConfig().tenantConnectionNamePrefix}${tenantId}`
  }

  /** Refresh the in-use grace window for a tenant's connection on every query. */
  markUsed(tenantId: string): void {
    const name = this.connectionName(tenantId)
    if (this.#lru.has(name)) this.#lru.touch(name)
  }

  /** The Lucid connection name of a tenant's SELECT-only firewall clone. */
  readOnlyConnectionName(tenantId: string): string {
    return `${this.connectionName(tenantId)}${READ_ONLY_CONNECTION_SUFFIX}`
  }

  /**
   * Synchronously resolve the tenant's SELECT-only firewall connection, cloned
   * from the already-registered primary (same schema/database) but authenticated
   * as the read-only role. Built + registered on first use and tracked in the
   * SAME pool as the primary, so it is touched here, counts against the cap, and
   * is released on {@link disconnect} (this ownership is what closes the
   * per-tenant `__plugin_ro` pool leak the adapter-owned clone had). Fails CLOSED:
   * throws rather than returning a writable client if the clone cannot be built.
   */
  ensureReadOnlyClient(
    tenantId: string,
    db: Database,
    role: PluginReadOnlyConfig
  ): QueryClientContract {
    const primaryName = this.connectionName(tenantId)
    const roName = this.readOnlyConnectionName(tenantId)
    const manager = db.manager as ConnectionManagerContract | undefined
    // Without a real manager the clone cannot be established; refuse rather than
    // hand untrusted code the writable primary. (A bare unit-test double reaching
    // here under an untrusted scope is itself a misconfiguration.)
    if (!manager || typeof manager.has !== 'function') {
      throw new IsolationConfigException(
        `Untrusted plugin code requires the read-only connection firewall, but the ` +
          `database manager is unavailable for tenant ${tenantId}. Refusing to route ` +
          `untrusted code to the writable primary (fail-closed).`
      )
    }
    // A concurrent eviction may be draining this clone's pool (`manager.has` still
    // true, pool 'closing'). connect()/read-replica await settlePending here; this
    // path is synchronous and cannot, so refuse rather than re-adopt a draining
    // pool. Fail closed + transient: the next call rebuilds once the drain settles.
    if (this.#lru.hasPendingRelease(roName)) {
      throw new IsolationConfigException(
        `The read-only firewall connection "${roName}" for tenant ${tenantId} is being ` +
          `recycled; refusing to serve a draining pool (fail-closed, transient — retry).`
      )
    }
    if (!manager.has(roName) && typeof manager.add === 'function') {
      // The clone is a SECOND real PG connection (separate pool), so it counts
      // against the pool budget. Honor the same admission tiers as connect(), or
      // untrusted plugin traffic would push the pool past the cap/ceiling one clone
      // at a time. Refuse (fail-closed) rather than open connection N+1 for
      // untrusted code; an already-registered clone (checked above) still serves.
      if (this.#lru.atHardCeiling() || this.#lru.atHardLimit()) {
        throw new TenantConnectionLimitException()
      }
      // The primary must already be registered (context entry established it); its
      // config is the template for the clone.
      const primaryConfig = manager.get?.(primaryName)?.config
      if (primaryConfig) {
        // Seal the PRIMARY before cloning it read-only: refuse to build a
        // SELECT-only view of a connection that is not pinned to THIS tenant (a
        // stale or collided primary registration), which would otherwise hand
        // untrusted code a read-only window onto another tenant's data.
        this.verifyCachedConnection(
          { id: tenantId } as TenantModelContract,
          primaryConfig,
          primaryName
        )
        manager.add(roName, buildReadOnlyConnectionConfig(primaryConfig, role))
      }
    }
    if (!manager.has(roName)) {
      throw new IsolationConfigException(
        `Untrusted plugin code requires the read-only connection "${roName}", but it ` +
          `could not be established for tenant ${tenantId}. Refusing to route untrusted ` +
          `code to the writable primary (fail-closed).`
      )
    }
    this.#lru.touch(roName)
    this.#lru.evictIfNeeded()
    return db.connection(roName)
  }

  async connect(tenant: TenantModelContract, opts: { bypassHardCap?: boolean } = {}) {
    const { db } = await this.lucid()
    const name = this.connectionName(tenant.id)

    // If this connection was just evicted, wait for its pool to finish draining
    // before deciding it's still registered. Otherwise we'd re-adopt a closing
    // pool and queries would fail mid-flight.
    await this.#lru.settlePending(name)

    if (db.manager.has(name)) {
      // Verify the cached connection is still pinned to THIS tenant before serving
      // it (the shared cross-tenant identity seal). The subclass keys on the field
      // it overrides per tenant (searchPath / connection.database).
      this.verifyCachedConnection(tenant, db.manager.get(name)?.config, name)
      this.#lru.touch(name)
      return db.connection(name)
    }

    // Admission control on the request-serving path. Provisioning/reset/migration
    // pass bypassHardCap so onboarding is never refused by request-path backpressure
    // (which would also orphan freshly created storage). Two tiers:
    //   - the absolute ceiling (F1): ALWAYS refuses at/above
    //     maxTenantConnectionsHardCeiling, so an availability-favouring pool can
    //     never grow toward PostgreSQL max_connections;
    //   - the soft cap: refuses only under enforceConnectionCap when no connection
    //     is evictable.
    if (!opts.bypassHardCap && (this.#lru.atHardCeiling() || this.#lru.atHardLimit())) {
      throw new TenantConnectionLimitException()
    }

    const template = db.manager.get(this.templateConnectionName)?.config
    if (!template) {
      throw new IsolationConfigException(
        `${this.#label}: template connection "${this.templateConnectionName}" not found in db.manager. ` +
          `Configure it in config/database.ts.`
      )
    }

    db.manager.add(name, this.buildTenantConfig(template, tenant))

    this.#lru.touch(name)
    this.#lru.evictIfNeeded()

    return db.connection(name)
  }

  async disconnect(tenant: TenantModelContract): Promise<void> {
    const { db } = await this.lucid()
    // Release the primary AND its read-only firewall clone (whenever one was
    // established). The clone shares this pool, so leaving it registered leaks a
    // pool per tenant across provision/destroy cycles — the FD leak the
    // driver-owned clone closes.
    for (const name of [this.connectionName(tenant.id), this.readOnlyConnectionName(tenant.id)]) {
      this.#lru.delete(name)
      // If an eviction is already draining this pool, wait for it instead of
      // racing it with a second release (idempotent in Lucid, but the await
      // keeps the manager state deterministic for the `has()` check below).
      await this.#lru.settlePending(name)
      if (db.manager.has(name)) {
        // `release` both closes the pool and unregisters the connection from the
        // manager. `close` only ends the pool, so `manager.has()` would still
        // report true, leaking entries.
        await db.manager.release(name)
      }
    }
  }

  async migrate(tenant: TenantModelContract, opts: MigrateOptions): Promise<MigrateResult> {
    // Self-connect (bypassing the hard cap) so migrate() works regardless of
    // whether the caller pre-connected. An operational migration must never be
    // refused by request-path backpressure.
    await this.connect(tenant, { bypassHardCap: true })
    return runTenantMigrations(this.connectionName(tenant.id), opts)
  }

  /**
   * Build this tenant's Lucid connection config from the template connection's
   * config. Called once, when the connection is first registered.
   */
  protected abstract buildTenantConfig(template: any, tenant: TenantModelContract): any

  /**
   * The cached-connection identity seal: throw (via `assertCachedConnectionIdentity`)
   * if the connection already registered under `name` is not pinned to THIS
   * tenant's storage. Called on the cached-connection fast path of `connect()`
   * before the cached client is served.
   */
  protected abstract verifyCachedConnection(
    tenant: TenantModelContract,
    cachedConfig: unknown,
    name: string
  ): void

  abstract provision(tenant: TenantModelContract): Promise<void>
  abstract destroy(tenant: TenantModelContract, opts?: DestroyOptions): Promise<void>
  abstract reset(tenant: TenantModelContract): Promise<void>
  abstract tableLocation(tenant: TenantModelContract): TableLocation
}
