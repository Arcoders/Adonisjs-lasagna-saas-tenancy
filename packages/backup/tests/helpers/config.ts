import { setConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'
import type { BackupConfig } from '../../src/define_config.js'

/**
 * The backup block, exported on its own and typed as the required `BackupConfig`.
 * Specs that build a variant spread this rather than `testConfig.backup`: the
 * latter is `BackupConfig | undefined` through the satellite augmentation, and
 * spreading it would silently turn every required key optional.
 */
export const testBackupConfig: BackupConfig = {
  storagePath: '/tmp/backups',
  metadataTtl: 86400,
  pgConnection: {
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: 'postgres',
    database: 'test',
  },
}

/**
 * Package-local test config. Mirrors the core `tests/helpers/config.ts` but is
 * scoped to this package's unit runner (which runs from the package cwd without
 * booting an AdonisJS app). It seeds the module-level config singleton via the
 * app.booted-safe `/config` subpath so `getConfig()` resolves inside the
 * services under test.
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
  backup: testBackupConfig,
  cache: {
    ttl: 300,
    redis: { host: '127.0.0.1', port: 6379, db: 2 },
  },
}

export function setupTestConfig(overrides?: Partial<MultitenancyConfig>): void {
  setConfig({ ...testConfig, ...overrides })
}
