import { HttpContext } from '@adonisjs/core/http'
import type { HttpRequest } from '@adonisjs/core/http'
import type { Database } from '@adonisjs/lucid/database'
import type { LucidModel, ModelAdapterOptions } from '@adonisjs/lucid/types/model'
import assert from 'node:assert'
import { getConfig } from '../../config.js'
import IsolationConfigException from '../../exceptions/isolation_config_exception.js'
import IsthmusTenantMismatchException from '../../exceptions/isthmus_tenant_mismatch_exception.js'
import MissingTenantHeaderException from '../../exceptions/missing_tenant_header_exception.js'
import { memoizedTenantId, resolveTenantId } from '../../extensions/request.js'
import { emitIsthmusEvent } from '../../isthmus/audit.js'
import { isUuidV4 } from '../../services/isolation/identifier.js'
import type IsolationDriverRegistry from '../../services/isolation/registry.js'
import type TenantResolverRegistry from '../../services/resolvers/registry.js'
import { resolveIsolationKind } from '../base/isolation_kind.js'
import { tenancy } from '../../tenancy.js'
import { pluginScope } from '../../services/plugin_execution_scope.js'
import {
  buildReadOnlyConnectionConfig,
  READ_ONLY_CONNECTION_SUFFIX,
} from '../../services/plugin_read_only_connection.js'
import DefaultLucidAdapter from './default_lucid_adapter.js'

/** Per-request memo for the ContextSeal's HTTP-side comparand (see #requestComparandId). */
const HTTP_COMPARAND = Symbol('isthmus_http_comparand')

/**
 * Routes Lucid model queries to the right per-tenant connection by asking
 * the active `IsolationDriver` for the connection name.
 *
 * Resolution order for the active tenant id:
 *   1. Explicit `options.client` (already a connection)
 *   2. Explicit `options.connection` or `modelConstructor.connection`
 *   3. `tenancy.currentId()`, set by `tenancy.run(tenant, fn)` in queue
 *      jobs, scripts, custom commands
 *   4. The HTTP request resolver via `resolveTenantId(context.request)`
 */
export default class TenantAdapter extends DefaultLucidAdapter {
  constructor(
    db: Database,
    private readonly drivers: IsolationDriverRegistry,
    private readonly resolvers?: TenantResolverRegistry
  ) {
    super(db)
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

  override modelConstructorClient(modelConstructor: LucidModel, options?: ModelAdapterOptions) {
    if (options?.client) {
      return options.client
    }

    const explicit = options?.connection || modelConstructor?.connection
    if (explicit) {
      return this.db.connection(explicit)
    }

    const tenantId = this.#resolveTenantId()
    const driver = this.drivers.active()
    // Refresh the in-use grace window so a request that runs longer than the
    // eviction grace period isn't picked as a victim mid-query. No-op on drivers
    // without a per-tenant pool (rowscope-pg).
    driver.markUsed?.(tenantId)
    const name = driver.connectionName(tenantId)
    // The adapter routes to a connection it does not register; establishing it
    // is the job of context entry (request.tenant() on the HTTP path,
    // tenancy.run() for jobs/scripts/commands, both of which call
    // driver.connect()). If we reach here with no registered connection, fail
    // closed with a typed, actionable error instead of letting Lucid throw an
    // opaque "connection is not registered". A real Database always exposes a
    // manager; a bare unit-test double without one skips the check.
    const manager: any = (this.db as any).manager
    if (manager && typeof manager.has === 'function' && !manager.has(name)) {
      throw new IsolationConfigException(
        `Tenant connection "${name}" is not established for tenant ${tenantId}. ` +
          `Enter tenant context first: request.tenant() on the HTTP path, or ` +
          `tenancy.run(tenant, fn) in jobs, scripts, and custom commands.`
      )
    }
    // Untrusted-plugin read-only routing (the Postgres-enforced firewall):
    // when UNTRUSTED plugin code is on the stack and a read-only role is
    // configured, route this query to a connection cloned from the tenant's own
    // (same database/schema) but authenticated as the SELECT-only role, so a write
    // is denied by Postgres, not a JS proxy. The clone is synchronous: the
    // primary is registered (asserted above), so its config is available now.
    const readOnly = getConfig().plugins?.readOnly
    if (readOnly && pluginScope.untrustedActive()) {
      // Fail CLOSED, not open: once untrusted plugin code is on the stack and a
      // read-only role is configured, this query MUST route to the SELECT-only
      // clone. If the clone cannot be established, DENY. Never fall through to the
      // writable primary, which would hand write access to exactly the code the
      // firewall exists to contain. A bare unit-test double without a manager
      // reaching here under an untrusted scope is itself a misconfiguration.
      if (!manager || typeof manager.has !== 'function') {
        throw new IsolationConfigException(
          `Untrusted plugin code requires the read-only connection firewall, but the ` +
            `database manager is unavailable for tenant ${tenantId}. Refusing to route ` +
            `untrusted code to the writable primary (fail-closed).`
        )
      }
      const roName = `${name}${READ_ONLY_CONNECTION_SUFFIX}`
      if (typeof manager.add === 'function' && !manager.has(roName)) {
        const primaryConfig = manager.get?.(name)?.config
        if (primaryConfig) {
          manager.add(roName, buildReadOnlyConnectionConfig(primaryConfig, readOnly))
        }
      }
      if (!manager.has(roName)) {
        throw new IsolationConfigException(
          `Untrusted plugin code requires the read-only connection "${roName}", but it ` +
            `could not be established for tenant ${tenantId}. Refusing to route untrusted ` +
            `code to the writable primary (fail-closed).`
        )
      }
      const roClient = this.db.connection(roName)
      driver.enforce(roClient, tenantId)
      return roClient
    }

    // Give the driver a chance to apply its tenant boundary to the resolved
    // client (a no-op for connection-isolated drivers; the explicit contract
    // point for row-scoping ones). See IsolationDriver.enforce.
    const client = this.db.connection(name)
    driver.enforce(client, tenantId)
    return client
  }

  /**
   * Pulls the active tenant id from `tenancy.run()` first, then from the
   * HTTP request. Throws if neither yields a valid id.
   *
   * ContextSeal (an Isthmus invariant): on the guarded HTTP path BOTH sources
   * are present: the guard wraps `next()` in `tenancy.runForRequest`, so
   * `tenancy.currentId()` and the request resolve the same tenant and this
   * check is a memoized string compare. When they DISAGREE (code inside a
   * tenant-resolving request entered `tenancy.run(otherTenant)`, context
   * confusion), fail closed instead of silently routing under the scope's
   * tenant. Jobs and commands have no HttpContext, so the seal is inert there;
   * an explicit `connection`/`client` option never reaches this method.
   */
  #resolveTenantId(): string {
    const fromTenancy = tenancy.currentId()
    if (fromTenancy) {
      const context = HttpContext.get()
      if (context) {
        const fromRequest = this.#requestComparandId(context)
        if (fromRequest && fromRequest !== fromTenancy) {
          emitIsthmusEvent('seal.tenant_context', {
            tenantId: fromTenancy,
            metadata: { requestResolvedId: fromRequest },
          })
          throw new IsthmusTenantMismatchException(fromTenancy, fromRequest)
        }
      }
      return fromTenancy
    }

    const context = HttpContext.get()
    if (!context) {
      throw new MissingTenantHeaderException()
    }

    const tenantId = this.#resolveIdFromRequest(context.request)
    assert(tenantId && isUuidV4(tenantId), new MissingTenantHeaderException())
    return tenantId
  }

  /**
   * The HTTP side of the ContextSeal compare, computed once per request and
   * memoized on the request object. Prefers the id the guard/macro already
   * resolved (`request.tenant()`, which covers async `domain` resolution), falling
   * back to the synchronous resolver chain. A `null` result (a genuine central
   * route) is NOT cached: the guard may memoize the tenant later in the same
   * request, and the next query should see it.
   */
  #requestComparandId(context: HttpContext): string | null {
    const request = context.request as HttpRequest & { [HTTP_COMPARAND]?: string }
    const memoized = request[HTTP_COMPARAND]
    if (memoized !== undefined) return memoized

    const fromMacro = memoizedTenantId(context.request)
    if (fromMacro) {
      request[HTTP_COMPARAND] = fromMacro
      return fromMacro
    }
    const fromSync = this.#resolveIdFromRequest(context.request)
    if (fromSync) {
      request[HTTP_COMPARAND] = fromSync
      return fromSync
    }
    return null
  }

  /**
   * Resolve a tenant id directly from the request for the fallback path (no
   * active tenancy context). Honors `config.resolver.legacyAdapterFallback`:
   * the default (`false`) consults the resolver chain synchronously so custom
   * resolvers route model queries too; set it to `true` to restore the
   * historical `resolverStrategy`-only switch. A `domain` hit yields no
   * synchronous id (it needs an async repository lookup), so those flows must
   * establish context via `request.tenant()` first.
   */
  #resolveIdFromRequest(request: HttpRequest): string | undefined {
    const legacy = getConfig().resolver?.legacyAdapterFallback ?? false
    if (!legacy && this.resolvers) {
      const result = this.resolvers.resolveSync(request)
      return result?.type === 'id' ? result.tenantId : undefined
    }
    return resolveTenantId(request)
  }
}
