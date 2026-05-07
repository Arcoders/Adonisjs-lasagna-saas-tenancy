import env from '#start/env'
import type { TenantResolverStrategy } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Full configuration exercising every optional block:
 *  - lifecycle hooks (beforeCreate gates email allowlist; afterCreate logs)
 *  - declarative plans + quotas
 *  - read replicas (single replica = primary in this demo)
 *  - backup retention with two tiers
 *  - soft-delete TTL
 */
export default {
  // ─── Schema and connection names ─────────────────────────────────
  backofficeSchemaName: 'backoffice',
  backofficeConnectionName: 'backoffice',
  centralSchemaName: 'public',
  centralConnectionName: 'public',
  tenantConnectionNamePrefix: 'tenant_',
  tenantSchemaPrefix: 'tenant_',

  // ─── Resolution ──────────────────────────────────────────────────
  resolverStrategy: 'header' as TenantResolverStrategy,
  tenantHeaderKey: env.get('TENANT_HEADER_KEY'),
  baseDomain: env.get('APP_DOMAIN'),

  // Health and admin endpoints don't carry a tenant — let them through.
  ignorePaths: ['/livez', '/readyz', '/healthz', '/metrics', '/admin'],

  schemaCacheTtl: 300,
  maintenanceSchedule: { backupHour: 2, migrateAllHour: 3 },

  // ─── Circuit breaker ─────────────────────────────────────────────
  // `volumeThreshold: 10` is friendlier in dev than the default `2`,
  // which trips immediately on a single bad seed.
  circuitBreaker: {
    threshold: 50,
    resetTimeout: 30_000,
    rollingCountTimeout: 10_000,
    volumeThreshold: 10,
  },

  // ─── Per-tenant queues ───────────────────────────────────────────
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

  // ─── Backups ─────────────────────────────────────────────────────
  backup: {
    storagePath: env.get('BACKUP_STORAGE_PATH', './storage/backups'),
    metadataTtl: 86_400,
    pgConnection: {
      host: env.get('DB_HOST'),
      port: env.get('DB_PORT'),
      user: env.get('DB_USER'),
      password: env.get('DB_PASSWORD', ''),
      database: env.get('DB_DATABASE'),
    },
    s3: env.get('BACKUP_S3_ENABLED')
      ? {
          enabled: true,
          bucket: env.get('BACKUP_S3_BUCKET', ''),
          region: env.get('BACKUP_S3_REGION', 'us-east-1'),
          endpoint: env.get('BACKUP_S3_ENDPOINT', ''),
          accessKeyId: env.get('AWS_ACCESS_KEY_ID', ''),
          secretAccessKey: env.get('AWS_SECRET_ACCESS_KEY', ''),
        }
      : undefined,

    // Two-tier retention. tenant:backups:run reads this.
    retention: {
      defaultTier: 'standard',
      tiers: {
        standard: { intervalHours: 24, keepLast: 7 },
        premium: { intervalHours: 6, keepLast: 30 },
      },
      // Pick the tier from the tenant's typed metadata. See app/models/backoffice/tenant.ts.
      getTier: (tenant: any) => tenant.metadata?.tier ?? 'standard',
    },
  },

  // ─── Cache (BentoCache) ──────────────────────────────────────────
  cache: {
    ttl: 300,
    redis: {
      host: env.get('CACHE_REDIS_HOST'),
      port: env.get('CACHE_REDIS_PORT'),
      db: env.get('CACHE_REDIS_DB'),
    },
  },

  // ─── Lifecycle hooks (declarative form) ──────────────────────────
  // `beforeProvision` runs inside the InstallTenant job; throwing aborts
  // provisioning and the tenant flips to status=failed.
  // `after*` hooks are best-effort and continue on error.
  hooks: {
    beforeProvision: async ({ tenant }: { tenant: { email: string } }) => {
      if (!tenant.email.endsWith('.test')) {
        throw new Error(
          `Demo enforces *.test emails only — got "${tenant.email}". This shows beforeProvision aborting.`
        )
      }
    },
  },

  // ─── Soft-delete TTL ─────────────────────────────────────────────
  // tenant:purge-expired drops schemas older than this many days.
  softDelete: {
    retentionDays: 30,
  },

  // ─── Plans + quotas ──────────────────────────────────────────────
  // The demo middleware enforceQuota('apiCallsPerDay') is wired on /demo/notes.
  plans: {
    defaultPlan: 'free',
    definitions: {
      free: { limits: { apiCallsPerDay: 50, notesPerTenant: 10 } },
      pro: { limits: { apiCallsPerDay: 10_000, notesPerTenant: 1_000 } },
    },
    getPlan: (tenant: any) => tenant.metadata?.plan ?? 'free',
  },

  // ─── Read replica routing ────────────────────────────────────────
  // In docker-compose we only have one Postgres — pointing the "replica"
  // at the same host is fine for demonstrating the routing API.
  // Disable by removing this block.
  tenantReadReplicas: {
    hosts: [{ host: env.get('DB_HOST'), name: 'demo-replica-1' }],
    strategy: 'sticky',
    connectionSuffix: '_read',
  },
} as const
