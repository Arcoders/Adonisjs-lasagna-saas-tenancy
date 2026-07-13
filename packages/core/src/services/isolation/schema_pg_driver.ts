import { getConfig } from '../../config.js'
import type { TenantModelContract } from '../../types/contracts.js'
import type { DestroyOptions, IsolationDriverName, TableLocation } from './driver.js'
import { assertCachedConnectionIdentity } from './connection_identity_seal.js'
import { assertSafeIdentifier } from '../../isthmus/guarded_identifier.js'
import { PGVECTOR_EXTENSION_SCHEMA } from './pgvector.js'
import PooledPgDriver from './pooled_pg_driver.js'

/**
 * Default isolation driver: each tenant gets its own PostgreSQL schema
 * (`tenant_<uuid>`) on a shared database. Connections are registered
 * lazily into Lucid's manager with a `searchPath` pointing at the
 * tenant's schema. The shared {@link PooledPgDriver} base owns the bounded
 * connection pool and the connect/disconnect/markUsed/migrate flow; this class
 * supplies the schema-specific config, seal, DDL, and placement.
 */
export default class SchemaPgDriver extends PooledPgDriver {
  readonly name: IsolationDriverName = 'schema-pg'

  constructor(opts: { templateConnectionName?: string } = {}) {
    super({ ...opts, label: 'SchemaPgDriver' })
  }

  schemaName(tenant: TenantModelContract | string): string {
    const id = typeof tenant === 'string' ? tenant : tenant.id
    assertSafeIdentifier(id, 'tenant id')
    return `${getConfig().tenantSchemaPrefix}${id}`
  }

  tableLocation(tenant: TenantModelContract): TableLocation {
    // schemaName() and connectionName() both assertSafeIdentifier the id, so a
    // malformed tenant id throws here exactly as it would at the DDL seam.
    return {
      kind: 'schema',
      schema: this.schemaName(tenant),
      connectionName: this.connectionName(tenant.id),
    }
  }

  protected buildTenantConfig(template: any, tenant: TenantModelContract): any {
    // The tenant's own schema stays FIRST (all tenant objects resolve there), with
    // the shared pgvector `extensions` schema appended so a bare `vector(N)` column
    // and operator class resolve without putting `public` (which holds central data)
    // on the tenant path. The schema is absent for non-pgvector hosts; PostgreSQL
    // silently ignores a non-existent schema in search_path, so this is a no-op there.
    return {
      ...template,
      searchPath: [this.schemaName(tenant), PGVECTOR_EXTENSION_SCHEMA],
    }
  }

  protected verifyCachedConnection(
    tenant: TenantModelContract,
    cachedConfig: unknown,
    name: string
  ): void {
    // schema-pg keys the seal on the connection's searchPath (the field
    // buildTenantConfig sets per tenant).
    const existing = cachedConfig as { searchPath?: unknown } | undefined
    const expected = this.schemaName(tenant)
    const actual = Array.isArray(existing?.searchPath)
      ? existing.searchPath[0]
      : existing?.searchPath
    assertCachedConnectionIdentity({
      driverLabel: 'SchemaPgDriver',
      tenantId: tenant.id,
      connection: name,
      identityKind: 'searchPath',
      expected,
      actualDisplay: JSON.stringify(existing?.searchPath),
      matches: actual === expected,
    })
  }

  async provision(tenant: TenantModelContract): Promise<void> {
    const schema = this.schemaName(tenant)
    const { db } = await this.lucid()
    await db.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    await this.connect(tenant, { bypassHardCap: true })
  }

  async destroy(tenant: TenantModelContract, opts: DestroyOptions = {}): Promise<void> {
    const schema = this.schemaName(tenant)
    await this.disconnect(tenant)
    if (opts.keepData) return
    const { db } = await this.lucid()
    await db.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  }

  async reset(tenant: TenantModelContract): Promise<void> {
    const schema = this.schemaName(tenant)
    await this.disconnect(tenant)
    const { db } = await this.lucid()
    await db.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await db.rawQuery(`CREATE SCHEMA "${schema}"`)
    await this.connect(tenant, { bypassHardCap: true })
  }
}
