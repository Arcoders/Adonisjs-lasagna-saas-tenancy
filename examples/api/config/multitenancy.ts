import env from '#start/env'
import type { TenantResolverStrategy } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Full configuration exercising every optional block:
 *  - lifecycle hook (beforeProvision rejects non-.test emails to demo a hook aborting provisioning)
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
  ignorePaths: ['/livez', '/readyz', '/healthz', '/metrics', '/admin', '/webhooks/billing'],

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
    // Demo-only business rule, deliberately placed in the hook to show a
    // throwing beforeProvision aborting provisioning (status flips to failed —
    // see tests/e2e/full.spec.ts). A production app would keep domain rules
    // like this in a service or validator; email shape already lives in
    // app/validators/tenants_validator.ts.
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

  // ─── Compliance tooling seam ─────────────────────────────────────
  // Powers `tenant:gdpr:anonymize` (GDPR Art.17 erasure-by-anonymization). The
  // package never touches your models — YOU decide what PII is and how to mask
  // it. This runs inside tenancy.run(tenant), so Note queries hit the tenant's
  // own schema. Honors dryRun (count, don't write) and returns { affected } for
  // the audit trail. Here Note stands in for a PII-bearing model.
  compliance: {
    anonymize: async ({ dryRun }: { dryRun: boolean }) => {
      const { default: Note } = await import('#app/models/tenant_scoped/note')
      const notes = await Note.all()
      if (dryRun) return { affected: notes.length }
      for (const note of notes) {
        note.title = 'Redacted'
        note.body = null
        await note.save()
      }
      return { affected: notes.length }
    },
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
  // demonstrates lives in docs/guides/cookbook/adding-features-incrementally.md.
  // The keys are safe placeholders: BillingService.verify() runs at boot but
  // only validates the key shape (no network), and the e2e suite injects
  // MockStripe, so no real Stripe account is needed. `products` maps Stripe
  // product ids to plans declared in `plans.definitions` above.
  billing: {
    // Configurable so deploys can pick a provider without a code change (and so
    // the satellite_boot_failure e2e can point it at a bogus driver to prove the
    // billing provider fails the boot fast and names itself). Defaults to stripe.
    driver: env.get('BILLING_DRIVER', 'stripe'),
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

  // ─── Reporting (@adonisjs-lasagna/reporting) ─────────────────────
  // Opt into the monthly rollup read path (run `tenant:metrics:rollup` to fill it)
  // and clear the dashboard cache the moment a flush lands.
  reporting: {
    rollups: { enabled: true },
    cache: { invalidateOnFlush: true },
  },

  // ─── AI satellite (@adonisjs-lasagna/ai) ─────────────────────────
  // Fully offline in the demo: AppProvider registers a MockAIProvider (chat) and a
  // MockEmbeddingProvider (embed/retrieve) so the AI e2e run with no network. The
  // `dimension: 8` here is baked into the per-tenant `ai_embeddings vector(8)` column
  // by the satellite migration and matches the mock's vectors. `retrievalFilter`
  // returns the tenant-wide scope (isolation stays structural, per-tenant schema);
  // `authorizeAIAccess` is open for the demo; `resolvePrincipal` reads `x-ai-user`.
  // The AI routes are mounted under TenantGuard in start/routes.ts. `baseUrl` is an
  // unreachable https placeholder: the mock override means it is never dialed. The
  // AI e2e self-skip unless Postgres has the pgvector extension.
  ai: {
    allowedProviders: ['mock'],
    defaultProvider: 'mock',
    authorizeAIAccess: () => true,
    resolvePrincipal: (ctx: any) => ctx.request.header('x-ai-user') ?? null,
    rateLimit: { limit: 5, windowSeconds: 60 },
    audit: { enabled: true },
    embedding: {
      provider: 'mock-embedding',
      apiKey: 'demo-embeddings-key',
      baseUrl: 'https://embeddings.invalid',
      dimension: 8,
      authorizeIngestion: () => true,
    },
    retrieval: { retrievalFilter: () => ({ kind: 'all' as const }) },
    // A demo output-redaction (DLP) hook: strip anything shaped like an SSN from
    // the model's streamed output. Host-owned defense-in-depth, NEVER the isolation
    // control (I4/I8 remain the guarantee); the mandatory output bound still runs.
    // Proven end to end by the ai_output_redaction e2e.
    redactOutput: (_ctx: any, _tenant: any, chunk: string) =>
      chunk.replace(/SSN-\d{3}-\d{2}-\d{4}/g, '[redacted]'),
  },
} as const
