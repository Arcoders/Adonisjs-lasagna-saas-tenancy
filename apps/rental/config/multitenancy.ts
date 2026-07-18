import env from '#start/env'
import type { TenantResolverStrategy } from '@adonisjs-lasagna/saas-tenancy/types'
import type { DeclarativeHooks } from '@adonisjs-lasagna/saas-tenancy/services'
import { createMembershipAuthorizer } from '#app/security/membership_authorizer'
import { authorizeFleetTool, fleetTools } from '#app/ai/fleet_tools'

// Stream the real DeepSeek model when its key is present, EXCEPT under the test
// runner, where the deterministic mock keeps the e2e assertions stable. AppProvider
// reads the same predicate to decide which chat provider to register.
const aiUsesDeepSeek = !!env.get('DEEPSEEK_API_KEY') && env.get('NODE_ENV') !== 'test'

/**
 * The multitenancy kernel configuration for Karimoto.
 *
 * Satellite blocks (backup, billing, ai, crypto, reporting, websockets,
 * compliance) are layered on in the satellite-wiring phase; this file holds the
 * core spine: schema/connection names, tenant resolution, the membership gate,
 * lifecycle hooks, plans + quotas, the circuit breaker and per-tenant queues.
 */
export default {
  // ─── Schema and connection names ─────────────────────────────────
  backofficeSchemaName: 'backoffice',
  backofficeConnectionName: 'backoffice',
  centralSchemaName: 'public',
  centralConnectionName: 'public',
  tenantConnectionNamePrefix: 'tenant_',
  tenantSchemaPrefix: 'tenant_',

  // ─── Isolation ───────────────────────────────────────────────────
  // Migrate + seed each new company to head as part of provisioning, so a
  // UI-created company is born fully migrated (never active-but-unmigrated, the
  // class of bug that returned a 503 on "Run doctor"). `tenant:migrate` stays
  // available and idempotent for the existing fleet.
  isolation: {
    migrateOnProvision: true,
  },

  // ─── Resolution ──────────────────────────────────────────────────
  // Each rental company gets a vanity host `<slug>.localhost` stored as the
  // tenant's `custom_domain`. The chain tries `domain-or-subdomain` first (the
  // browser hits `acme.localhost:3333`, resolved via `findByDomain`), then falls
  // back to the `x-tenant-id` UUID header for the programmatic API and the e2e
  // suite (which also keeps the synchronous routing path fed). The operator
  // console lives on the apex `localhost` (no tenant → central plane).
  resolverStrategy: 'domain-or-subdomain' as TenantResolverStrategy,
  resolverChain: ['domain-or-subdomain', 'header'],
  // Only hosts under `.localhost` may pick a tenant, so a spoofed
  // X-Forwarded-Host can never hop into another company's schema.
  resolver: { expectedHostSuffix: ['localhost'] },
  tenantHeaderKey: env.get('TENANT_HEADER_KEY'),
  baseDomain: env.get('APP_DOMAIN'),

  // ─── Membership gate (cross-tenant IDOR firewall) ────────────────
  // Deny-by-default: an authenticated caller's credentials must belong to the
  // resolved tenant, and anonymous traffic is refused except at the handful of
  // public entry points (login, SSO). See app/security/membership_authorizer.ts.
  authorizeTenantAccess: createMembershipAuthorizer(),

  // Health, the operator console and the billing webhook carry no tenant, so
  // they bypass resolution. The webhook resolves its tenant from the event later.
  ignorePaths: ['/livez', '/readyz', '/healthz', '/metrics', '/admin', '/webhooks/billing'],

  schemaCacheTtl: 300,
  maintenanceSchedule: { backupHour: 2, migrateAllHour: 3 },

  // ─── Admin impersonation ─────────────────────────────────────────
  impersonation: {
    secret: env.get(
      'IMPERSONATION_SECRET',
      'karimoto-dev-impersonation-secret-change-me-0123456789abcdef'
    ),
  },

  // ─── Circuit breaker ─────────────────────────────────────────────
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
  hooks: {
    // Runs inside the InstallTenant job; throwing aborts provisioning and the
    // tenant flips to status=failed. A light shape check here proves the seam
    // without blocking real onboarding data.
    beforeProvision: async ({ tenant }) => {
      if (!tenant.email.includes('@')) {
        throw new Error(
          `Refusing to provision "${tenant.name}": "${tenant.email}" is not an email.`
        )
      }
    },

    // Seed a demo staff user inside each freshly migrated tenant schema so the
    // tenant realm has someone to log in as. Gated on DEMO_SEED_TENANT_USERS and
    // refused in production; idempotent via updateOrCreate.
    afterMigrate: async ({ tenant, direction }) => {
      if (direction !== 'up') return
      if (!env.get('DEMO_SEED_TENANT_USERS')) return
      const { default: app } = await import('@adonisjs/core/services/app')
      if (app.inProduction) return
      const { tenancy } = await import('@adonisjs-lasagna/saas-tenancy')
      const { default: TenantUser } = await import('#app/models/tenant_scoped/tenant_user')
      const { DEMO_TENANT_OWNER } = await import('#app/helpers/rental_credentials')
      await tenancy.run(tenant, async () => {
        await TenantUser.updateOrCreate(
          { email: DEMO_TENANT_OWNER.email },
          {
            password: DEMO_TENANT_OWNER.password,
            fullName: DEMO_TENANT_OWNER.fullName,
            role: 'owner',
          }
        )
      })
    },
  } satisfies DeclarativeHooks,

  // ─── Soft-delete TTL ─────────────────────────────────────────────
  // tenant:purge-expired drops schemas older than this many days.
  softDelete: {
    retentionDays: 30,
  },

  // ─── Plans + quotas ──────────────────────────────────────────────
  // The company (tenant) subscribes to one of these; the billing satellite
  // maps a Stripe subscription to the plan and QuotaService enforces the limits.
  // enforceQuota('vehiclesPerTenant' | 'bookingsPerMonth') is wired on the
  // domain routes; apiCallsPerDay guards the general tenant surface.
  plans: {
    defaultPlan: 'starter',
    definitions: {
      starter: {
        limits: {
          vehiclesPerTenant: 10,
          bookingsPerMonth: 100,
          apiCallsPerDay: 2_000,
          aiTokens: 50_000,
        },
      },
      fleet: {
        limits: {
          vehiclesPerTenant: 100,
          bookingsPerMonth: 2_000,
          apiCallsPerDay: 20_000,
          aiTokens: 500_000,
        },
      },
      enterprise: {
        limits: {
          vehiclesPerTenant: 100_000,
          bookingsPerMonth: 100_000,
          apiCallsPerDay: 1_000_000,
          aiTokens: 5_000_000,
        },
      },
    },
    getPlan: (tenant: any) => tenant.metadata?.plan ?? 'starter',
  },

  // ─── Read replica routing ────────────────────────────────────────
  // Wire a replica ONLY when DB_REPLICA_HOST is set. Local dev runs a single
  // Postgres with no standby, so the block stays absent and the replica_lag doctor
  // check returns [] rather than probing the primary and raising a false
  // points-at-primary signal (WS-6 catches that case too, as belt-and-suspenders).
  // Set DB_REPLICA_HOST to a real standby to exercise read routing; vehicle listings
  // read through the `_read` connection.
  ...(env.get('DB_REPLICA_HOST')
    ? {
        tenantReadReplicas: {
          hosts: [{ host: env.get('DB_REPLICA_HOST')!, name: 'karimoto-replica-1' }],
          strategy: 'sticky' as const,
          connectionSuffix: '_read',
        },
      }
    : {}),

  // ─── Compliance (GDPR / Law 09-08 erasure seam) ──────────────────
  // Backs `tenant:gdpr:anonymize`. Runs inside tenancy.run(tenant), so Customer
  // queries hit the company's own schema. Masks renter PII while keeping the
  // booking history intact.
  compliance: {
    anonymize: async ({ dryRun }: { dryRun: boolean }) => {
      const { default: Customer } = await import('#app/models/tenant_scoped/customer')
      const customers = await Customer.all()
      if (dryRun) return { affected: customers.length }
      for (const c of customers) {
        c.fullName = 'Redacted'
        c.email = null
        c.phone = null
        c.cin = null
        c.driverLicense = null
        c.passport = null
        c.address = null
        await c.save()
      }
      return { affected: customers.length }
    },
  },

  // ─── Backups (@adonisjs-lasagna/backup) ──────────────────────────
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
    // Two retention tiers keyed off tenant.metadata.tier.
    retention: {
      defaultTier: 'standard',
      tiers: {
        standard: { intervalHours: 24, keepLast: 7 },
        premium: { intervalHours: 6, keepLast: 30 },
      },
      getTier: (tenant: any) => tenant.metadata?.tier ?? 'standard',
    },
  },

  // ─── Reporting (@adonisjs-lasagna/reporting) ─────────────────────
  reporting: {
    rollups: { enabled: true },
    cache: { invalidateOnFlush: true },
  },

  // ─── Billing (@adonisjs-lasagna/billing) ─────────────────────────
  // The COMPANY (tenant) subscribes to Karimoto. Fully offline in dev: with no
  // STRIPE_API_KEY, AppProvider injects MockStripe into the stripe driver, so
  // checkout/portal/webhook run in-memory. Set STRIPE_API_KEY (sk_test_…) to go
  // live with zero code change. `products` maps price ids to the SaaS plans.
  billing: {
    driver: env.get('BILLING_DRIVER', 'stripe'),
    stripe: {
      apiKey: env.get('STRIPE_API_KEY', 'sk_test_karimoto_placeholder_key'),
      webhookSecret: env.get('STRIPE_WEBHOOK_SECRET', 'whsec_karimoto_placeholder_secret'),
    },
    products: {
      price_starter_monthly: 'starter',
      price_fleet_monthly: 'fleet',
      price_enterprise_monthly: 'enterprise',
    },
    defaultPlan: 'starter',
  },

  // ─── Multi-tenant WebSockets (@adonisjs-lasagna/websockets) ──────
  // The provider attaches socket.io to the HTTP server and isolates connections
  // per company (resolved from io(url, { auth: { tenantId } })). start/socket.ts
  // registers the live booking-board handlers.
  websockets: {
    cors: { origin: true, credentials: true },
    handshake: { authKey: 'tenantId' },
    authorize: async () => true,
  },

  // ─── AI satellite (@adonisjs-lasagna/ai) ─────────────────────────
  // The fleet assistant. Offline by default via MockAIProvider + MockEmbedding
  // (registered in AppProvider). Set DEEPSEEK_API_KEY to stream the real DeepSeek
  // model (`deepseek-chat`, OpenAI-compatible) instead — the same code path,
  // provider swapped by config. The test env stays on the mock regardless, so the
  // e2e suite's deterministic assertions (the CIN-shaped DLP token) keep holding.
  // Chat provider only; embeddings stay on the mock (the `dimension: 8` matches
  // the per-tenant `ai_embeddings vector(8)` column the satellite folds into each
  // tenant migration), so RAG retrieves over the seeded mock-embedding space and
  // hands the matched fleet docs to whichever chat model is active.
  ai: {
    allowedProviders: aiUsesDeepSeek ? ['deepseek', 'mock'] : ['mock'],
    defaultProvider: aiUsesDeepSeek ? 'deepseek' : 'mock',
    ...(aiUsesDeepSeek
      ? { deepseek: { apiKey: env.get('DEEPSEEK_API_KEY')!, defaultModel: 'deepseek-chat' } }
      : {}),
    authorizeAIAccess: () => true,
    resolvePrincipal: (ctx: any) => ctx.request.header('x-ai-user') ?? null,
    rateLimit: { limit: 10, windowSeconds: 60 },
    audit: { enabled: true },
    embedding: {
      provider: 'mock-embedding',
      apiKey: 'demo-embeddings-key',
      baseUrl: 'https://embeddings.invalid',
      dimension: 8,
      authorizeIngestion: () => true,
    },
    retrieval: { retrievalFilter: () => ({ kind: 'all' as const }) },
    // Output DLP: strip anything shaped like a Moroccan CIN from streamed output.
    // Defense-in-depth, never the isolation control.
    redactOutput: (_ctx: any, _tenant: any, chunk: string) =>
      chunk.replace(/\b[A-Z]{1,2}\d{5,6}\b/g, '[redacted]'),
    // ─── Tool calling (WS-AI-11) ───────────────────────────────────
    // Read-only tools over this company's own tables, so the assistant can answer
    // live drill-downs ("which of my cars is free next weekend?") the RAG corpus
    // can't. These replace the old `/assistant/context` snapshot outright: the model
    // chooses what to look up, with arguments, per question — no fixed aggregate
    // folded into every turn.
    // Each handler is a plain Lucid query the tenant adapter already scopes; the
    // satellite runs it inside tenancy.run(tenant) and re-asserts the scope first.
    // authorizeTool is wired (never the acknowledgeUnauthorizedTools escape hatch)
    // and action tools stay off — nothing here mutates.
    tools: {
      registry: fleetTools,
      authorizeTool: authorizeFleetTool,
      actionTools: { enabled: false },
      // A simple question needs a lookup and an answer, but a "give me a report" pulls
      // several metrics at once (revenue + fleet + bookings + a ranking). 4 rounds ×
      // 3 tools (12 calls, under the hard 16 cap) covers a multi-metric report; the
      // system prompt's one-call-per-tool discipline keeps the loop from wandering
      // there rather than a tight ceiling tripping tool_budget_exhausted mid-report.
      maxRounds: 4,
      maxToolsPerRound: 3,
    },
  },

  // ─── crypto satellite (@adonisjs-lasagna/crypto) ─────────────────
  // Field-level encryption for renter PII (CIN / driver licence / passport),
  // each blind-index searchable. The dev `env` KeyProvider derives the KEK from
  // APP_KEY. The erasabilityResolver is the governance gate crypto CONSULTS
  // before a shred: the `renter-id` category is erasable on request (a renter
  // exercising their Law 09-08 erasure right); every other category is refused
  // fail-closed.
  crypto: {
    keyProvider: 'env',
    fields: {
      'customer.cin': { category: 'renter-id', searchable: true },
      'customer.driverLicense': { category: 'renter-id', searchable: true },
      'customer.passport': { category: 'renter-id', searchable: true },
    },
    erasabilityResolver: (_tenant: any, _subject: string, category: string) =>
      category === 'renter-id'
        ? { erasable: true, reason: 'consent' }
        : { erasable: false, reason: `category '${category}' is not erasable on request` },
  },
} as const
