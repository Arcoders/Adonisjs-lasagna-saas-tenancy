import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { setConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { MultitenancyConfig, TenantStatus } from '@adonisjs-lasagna/saas-tenancy/types'

export interface TestTenant {
  id: string
  name: string
  email: string
  status: TenantStatus
}

/** Insert a tenant row into `backoffice.tenants` and return its identity. */
export async function createTestTenant(
  overrides: Partial<{ name: string; email: string; status: TenantStatus }> = {}
): Promise<TestTenant> {
  const id = randomUUID()
  const name = overrides.name ?? `Test Tenant ${id.slice(0, 8)}`
  const email = overrides.email ?? `test-${id.slice(0, 8)}@fixture.test`
  const status: TenantStatus = overrides.status ?? 'active'

  await db.connection('backoffice').table('tenants').insert({
    id,
    name,
    email,
    status,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    custom_domain: null,
  })

  return { id, name, email, status }
}

/** Delete a tenant row from `backoffice.tenants`. */
export async function destroyTestTenant(tenantId: string): Promise<void> {
  await db.connection('backoffice').query().from('tenants').where('id', tenantId).delete()
}

/** Update a tenant's lifecycle status (e.g. to drive suspend/restore paths). */
export async function updateTenantStatus(tenantId: string, status: TenantStatus): Promise<void> {
  await db
    .connection('backoffice')
    .query()
    .from('tenants')
    .where('id', tenantId)
    .update({ status, updated_at: new Date() })
}

/**
 * A baseline config matching the integration environment (schema-based PG,
 * Redis on the CI ports). Spread overrides on top for a per-suite tweak. Use
 * {@link setupTestConfig} to install it into the module-level config singleton.
 */
export const testConfig: MultitenancyConfig = {
  backofficeSchemaName: 'backoffice',
  backofficeConnectionName: 'backoffice',
  centralSchemaName: 'public',
  centralConnectionName: 'public',
  tenantConnectionNamePrefix: 'tenant_',
  tenantSchemaPrefix: 'tenant_',
  resolverStrategy: 'header',
  tenantHeaderKey: 'x-tenant-id',
  baseDomain: 'example.com',
  schemaCacheTtl: 300,
  ignorePaths: ['/health', '/admin', '/api/webhooks'],
  maintenanceSchedule: { backupHour: 2, migrateAllHour: 3 },
  circuitBreaker: {
    threshold: 50,
    resetTimeout: 30000,
    rollingCountTimeout: 10000,
    volumeThreshold: 5,
  },
  queue: {
    tenantQueuePrefix: 'tenant_queue_',
    defaultConcurrency: 1,
    attempts: 3,
    redis: { host: '127.0.0.1', port: 6379, db: 1 },
  },
  cache: {
    ttl: 300,
    redis: { host: '127.0.0.1', port: 6379, db: 2 },
  },
}
// `backup` is intentionally absent: it is a satellite config block contributed
// via the backup package's `SatelliteConfigRegistry` augmentation, and this
// shared kit does not depend on the backup satellite. A suite that needs it sets
// it through its own typed override.

/** Install {@link testConfig} (shallow-merged with overrides) into the config singleton. */
export function setupTestConfig(overrides?: Partial<MultitenancyConfig>): void {
  setConfig({ ...testConfig, ...overrides })
}
