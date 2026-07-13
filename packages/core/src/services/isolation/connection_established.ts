import type { Database } from '@adonisjs/lucid/database'
import type { ConnectionManagerContract } from '@adonisjs/lucid/types/database'
import IsolationConfigException from '../../exceptions/isolation_config_exception.js'

/**
 * Fail closed with a typed, actionable error if a tenant's connection was never
 * established, instead of letting Lucid throw an opaque "connection is not
 * registered" when the adapter asks for it. Single-sourced across the drivers that
 * own a per-tenant connection — schema-pg/database-pg (via `PooledPgDriver`) and
 * sqlite-memory — so the message and the guard cannot drift between them. Drivers
 * whose connection is always registered (rowscope-pg's shared connection) don't
 * call it. A real Database always exposes a manager; a bare unit-test double
 * without one skips the check (the driver's own routing still covers it).
 */
export function assertTenantConnectionEstablished(
  tenantId: string,
  connectionName: string,
  db: Database
): void {
  const manager = db.manager as ConnectionManagerContract | undefined
  if (manager && typeof manager.has === 'function' && !manager.has(connectionName)) {
    throw new IsolationConfigException(
      `Tenant connection "${connectionName}" is not established for tenant ${tenantId}. ` +
        `Enter tenant context first: request.tenant() on the HTTP path, or ` +
        `tenancy.run(tenant, fn) in jobs, scripts, and custom commands.`
    )
  }
}
