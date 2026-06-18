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

  // Health, admin and the Stripe webhook don't carry a tenant — let them
  // through. The webhook resolves its tenant later from the event's customer id.
  ignorePaths: ['/livez', '/readyz', '/healthz', '/metrics', '/admin', '/webhooks/stripe'],

  schemaCacheTtl: 300,
  maintenanceSchedule: { backupHour: 2, migrateAllHour: 3 },

  // ─── Admin impersonation ─────────────────────────────────────────
  // Powers `tenant:impersonate`, the admin `/admin/impersonate` route, and
  // ImpersonationMiddleware. The secret must be ≥ 32 chars; in a real app
  // load it from a secret manager — never commit it.
  impersonation: {
    secret: 'demo-impersonation-secret-not-for-production-0123456789abcdef0123',
  },

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
      password: env.get('REDIS_PASSWORD'),
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
      password: env.get('REDIS_PASSWORD'),
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

  // ─── Billing (Stripe) ────────────────────────────────────────────
  // Added incrementally on top of the satellites above — the exact flow this
  // demonstrates lives in docs/cookbook/adding-features-incrementally.md.
  // The keys are safe placeholders: BillingService.verify() runs at boot but
  // only validates the key shape (no network), and the e2e suite injects
  // MockStripe, so no real Stripe account is needed. `products` maps Stripe
  // product ids to plans declared in `plans.definitions` above.
  billing: {
    driver: 'stripe',
    stripe: {
      apiKey: env.get('STRIPE_API_KEY', 'sk_test_demo_placeholder_key'),
      webhookSecret: env.get('STRIPE_WEBHOOK_SECRET', 'whsec_demo_placeholder_secret'),
    },
    // Maps Stripe product OR price ids to plans declared in `plans.definitions`.
    // The demo checkout uses `price_pro_monthly`, so it is allowlisted directly
    // here; that is what lets the controller skip `allowUnknownPrices`.
    products: { prod_pro: 'pro', price_pro_monthly: 'pro' },
    defaultPlan: 'free',
  },

  // ─── Multi-tenant WebSockets (socket.io) ─────────────────────────
  // Provided by @adonisjs-lasagna/websockets. The provider attaches socket.io
  // to the HTTP server and isolates connections per tenant; start/socket.ts
  // registers the chat handlers. Browsers connect with
  // io(url, { auth: { tenantId } }). `authorize` is the seam for real auth —
  // the demo accepts any resolved, active tenant.
  websockets: {
    cors: { origin: true, credentials: true },
    handshake: { authKey: 'tenantId' },
    authorize: async () => true,
  },

  // ─── Read replica routing ────────────────────────────────────────
  // Local dev runs a single Postgres, so the "replica" falls back to the
  // primary host — enough to demonstrate the routing API. The deploy e2e
  // stack (deploy/docker-compose.e2e.yml) sets DB_REPLICA_HOST to a real
  // streaming standby, so reads on the `_read` connection genuinely leave
  // the primary. Disable by removing this block.
  tenantReadReplicas: {
    hosts: [{ host: env.get('DB_REPLICA_HOST', env.get('DB_HOST')), name: 'demo-replica-1' }],
    strategy: 'sticky',
    connectionSuffix: '_read',
  },
} as const
