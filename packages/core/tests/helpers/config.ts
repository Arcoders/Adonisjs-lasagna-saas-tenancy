import { setConfig } from '../../src/config.js'
import type { MultitenancyConfig } from '../../src/types/config.js'

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
// `backup` / `billing` are satellite config blocks contributed via each
// satellite's `SatelliteConfigRegistry` augmentation; core's own test compilation
// does not import those satellites, so they are not on `MultitenancyConfig` here.

export function setupTestConfig(overrides?: Partial<MultitenancyConfig>): void {
  setConfig({ ...testConfig, ...overrides })
}
