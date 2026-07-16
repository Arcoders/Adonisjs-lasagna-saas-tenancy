import { emitIsthmusEvent } from '../../isthmus/audit.js'
import IsolationConfigException from '../../exceptions/isolation_config_exception.js'

/**
 * The cross-tenant cached-connection identity seal, shared by the pooled PG
 * drivers (schema-pg keys on the connection's `searchPath`, database-pg on its
 * `database`). Before serving a connection off the cached fast path, the driver
 * checks that the cached config still points at THIS tenant's namespace and
 * calls this seal: a name collision, a stale registration, or a changed prefix
 * would otherwise hand back a connection scoped to another tenant, a silent
 * cross-tenant leak. This is the single registered guard (`seal.connection_identity`)
 * for both drivers, so the fail-closed throw and its Isthmus emission live in one
 * place; AD-05 folds it into the shared `PooledPgDriver.verifyCachedConnection`
 * hook. Fails closed and OBSERVABLE (emits before throwing).
 */
export function assertCachedConnectionIdentity(params: {
  /** The concrete driver, for the operator-facing message, e.g. `'SchemaPgDriver'`. */
  driverLabel: string
  tenantId: string
  /** The Lucid connection name being served. */
  connection: string
  /** What the cached config is keyed on: `'searchPath'` (schema-pg) or `'database'`. */
  identityKind: string
  /** The namespace this tenant must resolve to (already `assertSafeIdentifier`-checked). */
  expected: string
  /** A display of what the cached connection actually carries, for the message. */
  actualDisplay: string
  /** The driver's own comparison result: true when the cached connection is this tenant's. */
  matches: boolean
}): void {
  if (params.matches) return
  emitIsthmusEvent('seal.connection_identity', {
    tenantId: params.tenantId,
    metadata: { connection: params.connection, expected: params.expected },
  })
  throw new IsolationConfigException(
    `${params.driverLabel}: connection "${params.connection}" is registered with ` +
      `${params.identityKind} ${params.actualDisplay} but tenant ${params.tenantId} expects ` +
      `"${params.expected}". Refusing to serve a possibly cross-tenant connection.`
  )
}
