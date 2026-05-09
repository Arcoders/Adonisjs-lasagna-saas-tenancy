import env from '../start/env.js'
import type { TenantResolverStrategy } from '@adonisjs-lasagna/saas-tenancy/types'

export default {
  backofficeSchemaName: 'backoffice',
  backofficeConnectionName: 'backoffice',
  centralSchemaName: 'public',
  centralConnectionName: 'public',
  tenantConnectionNamePrefix: 'tenant_',
  tenantSchemaPrefix: 'tenant_',
  resolverStrategy: 'header' as TenantResolverStrategy,
  tenantHeaderKey: env.get('TENANT_HEADER_KEY'),
  baseDomain: 'localhost',
  schemaCacheTtl: 300,
  ignorePaths: ['/health', '/admin', '/api/webhooks', '/webhooks/stripe'],
  maintenanceSchedule: { backupHour: 2, migrateAllHour: 3 },
  circuitBreaker: { threshold: 50, resetTimeout: 30000, rollingCountTimeout: 10000, volumeThreshold: 2 },
  queue: {
    tenantQueuePrefix: 'tenant_queue_',
    defaultConcurrency: 1,
    attempts: 3,
    redis: {
      host: env.get('QUEUE_REDIS_HOST'),
      port: env.get('QUEUE_REDIS_PORT'),
      db: env.get('QUEUE_REDIS_DB'),
    },
  },
  backup: {
    storagePath: '/tmp/backups',
    metadataTtl: 86400,
    pgConnection: {
      host: env.get('DB_HOST'),
      port: env.get('DB_PORT'),
      user: env.get('DB_USER'),
      password: env.get('DB_PASSWORD', ''),
      database: env.get('DB_DATABASE'),
    },
  },
  cache: {
    ttl: 300,
    redis: {
      host: env.get('CACHE_REDIS_HOST', env.get('QUEUE_REDIS_HOST', '127.0.0.1')),
      port: env.get('CACHE_REDIS_PORT', env.get('QUEUE_REDIS_PORT', 6379)),
      db: env.get('CACHE_REDIS_DB', 2),
    },
  },
  // Note: no `billing` / `plans` here on purpose. Billing-aware specs
  // call `setupBillingConfig(...)` in their own `setup` hook so the
  // tenant_delete and metered_usage specs (which wire their own listeners
  // ad-hoc) don't end up with the auto-wired provider listener firing
  // alongside their manual one — that would double the cancel/dispatch
  // count and break the assertions. The Stripe webhook route is still
  // mounted in `start/routes.ts` so HTTP-level specs can POST to it.
}
