import env from '../start/env.js'
import type {
  TenantResolverStrategy,
  TenantAccessAuthorizer,
} from '@adonisjs-lasagna/saas-tenancy/types'

export default {
  backofficeSchemaName: 'backoffice',
  backofficeConnectionName: 'backoffice',
  centralSchemaName: 'public',
  centralConnectionName: 'public',
  tenantConnectionNamePrefix: 'tenant_',
  tenantSchemaPrefix: 'tenant_',
  resolverStrategy: 'header' as TenantResolverStrategy,
  // Opt-in membership gate, exercised by tenant_guard_authorize.spec.ts. It is a
  // no-op for every other spec: only requests that send `x-test-principal-tenant`
  // (a stand-in for an authenticated principal's tenant) are evaluated, so the
  // gate doesn't disturb the rest of the shared integration suite. With the
  // header present, the caller's tenant must match the resolved tenant or the
  // guard returns 403, proving the seam closes the cross-tenant IDOR.
  authorizeTenantAccess: ((ctx, tenant) => {
    const principalTenant = ctx.request.header('x-test-principal-tenant')
    if (!principalTenant) return true
    return principalTenant === tenant.id
  }) satisfies TenantAccessAuthorizer,
  tenantHeaderKey: env.get('TENANT_HEADER_KEY'),
  baseDomain: 'localhost',
  schemaCacheTtl: 300,
  ignorePaths: ['/health', '/admin', '/api/webhooks', '/webhooks/billing'],
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
  // `backup` / `billing` are satellite config blocks. This fixture's config
  // object is intentionally untyped (consumed via the AdonisJS config registry),
  // so the blocks are plain runtime values here — the coexistence fixture
  // registers the billing + backup providers (see adonisrc.ts), and the billing
  // provider reads this block at boot to register its driver. Their TYPES live in
  // each satellite (contributed to MultitenancyConfig via SatelliteConfigRegistry
  // augmentation); core's own source never declares them.
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
  plans: {
    defaultPlan: 'starter',
    definitions: {
      starter: { limits: { apiRequests: 100 }, rateLimit: { limit: 3, windowSeconds: 2 } },
      pro: { limits: { apiRequests: 10_000 }, rateLimit: { limit: 10, windowSeconds: 2 } },
      team: { limits: { apiRequests: 50_000 } },
    },
    storage: 'tenant_plans',
  },
  // Present so the coexistence fixture's billing provider registers its driver at
  // boot (satellite_coexistence.spec.ts resolves BillingService). The billing
  // listener wiring moved to @adonisjs-lasagna/billing at the 1.0 extraction.
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
