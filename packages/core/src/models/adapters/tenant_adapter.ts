import type { Database } from '@adonisjs/lucid/database'
import type { LucidModel, LucidRow, ModelAdapterOptions } from '@adonisjs/lucid/types/model'
import { getConfig } from '../../config.js'
import IsolationConfigException from '../../exceptions/isolation_config_exception.js'
import { pluginScope } from '../../services/plugin_execution_scope.js'
import TenantContextResolver from '../../services/tenant_context_resolver.js'
import type IsolationDriverRegistry from '../../services/isolation/registry.js'
import type TenantResolverRegistry from '../../services/resolvers/registry.js'
import { resolveIsolationKind } from '../base/isolation_kind.js'
import DefaultLucidAdapter from './default_lucid_adapter.js'

/**
 * Routes Lucid model queries to the right per-tenant connection by asking the
 * active `IsolationDriver` for the connection name. The adapter is the thin seam
 * between two owners: tenant-id resolution and the ContextSeal live in
 * {@link TenantContextResolver}; connection ownership — the pool, the read-only
 * firewall clone, and the "is this tenant connection established?" check — lives in
 * the driver. So the routing path is: resolve the id, ask the driver for a client,
 * return it. An explicit `options.client`/`connection` short-circuits both.
 */
export default class TenantAdapter extends DefaultLucidAdapter {
  readonly #context: TenantContextResolver

  constructor(
    db: Database,
    private readonly drivers: IsolationDriverRegistry,
    resolvers?: TenantResolverRegistry
  ) {
    super(db)
    this.#context = new TenantContextResolver(resolvers)
  }

  /**
   * The unified adapter routes by the model's declarative `static isolation`
   * marker (default `tenant`). Backoffice models are schema-qualified at query
   * time; central and tenant models are not. Other ORM operations (insert,
   * update, delete, refresh) inherit the base adapter and route purely by
   * connection, exactly as before.
   */
  override query(modelConstructor: LucidModel, options?: ModelAdapterOptions): any {
    const client = this.modelConstructorClient(modelConstructor, options)
    const builder = client.modelQuery(modelConstructor)
    if (resolveIsolationKind(modelConstructor) === 'backoffice') {
      return builder.withSchema(getConfig().backofficeSchemaName)
    }
    return builder
  }

  /**
   * Schema-qualify a backoffice model's write/refresh query, SYMMETRIC with the
   * read qualification in `query()`. `insert`/`update`/`delete`/`refresh` bypass
   * `query()`, so without this a backoffice ORM write resolves its schema through
   * the `backoffice` connection's search_path — which the package never sets, only
   * the host does. A host that mis- or un-sets it would silently write to the
   * wrong schema while reads (already pinned) still target `backoffice`, so the
   * divergence reads as data loss. Explicit `.withSchema` pins every backoffice
   * write to `backoffice.<table>` independent of search_path, closing the
   * read/write asymmetry. `backoffice.<table>` is what the raw-SQL satellite
   * writers already emit, so this brings the ORM path in line with them.
   */
  protected override queryForInstance(
    instance: LucidRow,
    action: 'insert' | 'update' | 'delete' | 'refresh'
  ): any {
    const query = super.queryForInstance(instance, action)
    const modelConstructor = instance.constructor as unknown as LucidModel
    if (resolveIsolationKind(modelConstructor) === 'backoffice') {
      return query.withSchema(getConfig().backofficeSchemaName)
    }
    return query
  }

  override modelConstructorClient(modelConstructor: LucidModel, options?: ModelAdapterOptions) {
    if (options?.client) {
      return options.client
    }

    const explicit = options?.connection || modelConstructor?.connection
    if (explicit) {
      return this.db.connection(explicit)
    }

    const tenantId = this.#context.currentId({ seal: true })
    const driver = this.drivers.active()
    // Refresh the in-use grace window so a request that runs longer than the
    // eviction grace period isn't picked as a victim mid-query, then fail closed if
    // this tenant's connection was never established (a typed error instead of
    // Lucid's opaque one). Both are no-ops on a driver without a per-tenant pool.
    driver.markUsed?.(tenantId)
    driver.assertConnected?.(tenantId, this.db)

    // Untrusted-plugin read-only routing (the Postgres-enforced firewall): when
    // UNTRUSTED plugin code is on the stack and a read-only role is configured, route
    // this query to the tenant's SELECT-only clone so a write is denied by Postgres,
    // not a JS proxy. The DRIVER owns that clone (it builds, pools, and releases it);
    // the adapter only asks for it, synchronously, and fails CLOSED — untrusted code
    // MUST route to the SELECT-only clone or be denied, never fall through to the
    // writable primary. A driver with no per-tenant PG pool (rowscope-pg,
    // sqlite-memory) offers no firewall, so the query is denied rather than routed to
    // a shared/writable connection.
    const readOnly = getConfig().plugins?.readOnly
    if (readOnly && pluginScope.untrustedActive()) {
      const roClient = driver.ensureReadOnlyClient?.(tenantId, this.db, readOnly)
      if (!roClient) {
        throw new IsolationConfigException(
          `Untrusted plugin code requires the read-only connection firewall for tenant ` +
            `${tenantId}, but the active isolation driver "${driver.name}" does not provide one. ` +
            `Refusing to route untrusted code to a writable connection (fail-closed).`
        )
      }
      driver.enforce?.(roClient, tenantId)
      return roClient
    }

    // Give the driver its OPTIONAL synchronous per-query hook on the resolved
    // client. Omitted by every shipped driver (the connection or the withTenantScope
    // mixin is the boundary), so this is a no-op unless a custom driver implements it.
    const client = this.db.connection(driver.connectionName(tenantId))
    driver.enforce?.(client, tenantId)
    return client
  }
}
