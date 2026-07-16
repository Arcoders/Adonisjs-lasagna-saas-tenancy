import { setConfig } from '@adonisjs-lasagna/saas-tenancy/config'

/** A valid UUID v4 used as the active tenant id across the micro tier. */
export const FIXED_TENANT_ID = '11111111-1111-4111-8111-111111111111'

/**
 * Install a minimal config so `getConfig()` resolves on the CPU paths that read
 * it (resolvers, the driver's connectionName, the scope mixin). No app boot.
 * `setConfig` writes the same globalThis-keyed singleton the built core reads.
 */
export function installBenchConfig(): void {
  setConfig({
    backofficeSchemaName: 'backoffice',
    backofficeConnectionName: 'backoffice',
    centralSchemaName: 'public',
    centralConnectionName: 'public',
    tenantConnectionNamePrefix: 'tenant_',
    tenantSchemaPrefix: 'tenant_',
    resolverStrategy: 'header',
    tenantHeaderKey: 'x-tenant-id',
    baseDomain: 'localhost',
    ignorePaths: ['/health'],
    isolation: {
      driver: 'schema-pg',
      rowScopeColumn: 'tenant_id',
      rowScopeMode: 'strict',
    },
  } as any)
}
