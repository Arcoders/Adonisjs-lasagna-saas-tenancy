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
  circuitBreaker: {
    threshold: 50,
    resetTimeout: 30000,
    rollingCountTimeout: 10000,
    volumeThreshold: 2,
  },
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
  // Plans + billing are present at fixture-boot so
  // `MultitenancyProvider.start()` wires `TenantDestroyBillingListener`
  // into `HookRegistry` via the BUILD container — same identity the
  // tenant_delete spec resolves through `app.container.make(BillingService)`,
  // so its `__setStripeForTests(mock)` lands on the same instance the
  // listener uses to cancel.
  //
  // No `usageMapping` here: the metered_usage spec wires its own
  // listener (it stubs `ReportUsageBatchJob.dispatch` per-test), and
  // an auto-wired listener would fire too and double-dispatch the
  // batch.
  plans: {
    defaultPlan: 'starter',
    definitions: {
      starter: { limits: { apiRequests: 100 } },
      pro: { limits: { apiRequests: 10_000 } },
      team: { limits: { apiRequests: 50_000 } },
    },
    storage: 'tenant_plans',
  },
  billing: {
    driver: 'stripe',
    stripe: {
      apiKey: 'sk_test_fixture',
      webhookSecret: 'whsec_test_billing_helper',
    },
    products: { prod_starter: 'starter', prod_pro: 'pro', prod_team: 'team' },
    defaultPlan: 'starter',
  },
}
