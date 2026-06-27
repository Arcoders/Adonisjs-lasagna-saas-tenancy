import router from '@adonisjs/core/services/router'
import db from '@adonisjs/lucid/services/db'
import { middleware } from './kernel.js'
import { enforceRateLimit } from '@adonisjs-lasagna/saas-tenancy/middleware'
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'
import { multitenancyRoutes } from '@adonisjs-lasagna/saas-tenancy/health'

router.get('/health', async ({ response }) => {
  return response.ok({ status: 'ok' })
})

// Package operational probes under /ops (the bare /health above predates
// them). Used by the readyz_http integration spec to assert the real HTTP
// status codes (200 ok/degraded, 503 fail) Kubernetes probes would see.
// `metricsMiddleware: false` mounts /metrics public on purpose — this is a test
// fixture behind no network boundary, and the readyz_http spec asserts the raw
// HTTP status codes. Production must pass real auth (it now throws otherwise).
multitenancyRoutes({ prefix: '/ops', metricsMiddleware: false })

// Mount admin REST + OpenAPI docs without auth — the fixture is for tests
// only, and individual specs supply their own ad-hoc gating where needed.
// `middleware: false` is the explicit opt-out the package now requires.
// `resolveAdminActor` reads the acting admin from an `x-admin-id` header so the
// audit-attribution specs can assert both the attributed and the null-actor
// branches. `tenant_audit_logs.actor_id` is a uuid column, so tests send uuids.
multitenancyAdminRoutes({
  prefix: '/admin/multitenancy',
  middleware: false,
  resolveAdminActor: (ctx) => ctx.request.header('x-admin-id') ?? null,
})

// Mount the Stripe webhook receiver. Required by the dunning_flow,
// webhook_idempotency, ip_allowlist (HTTP variant), and pii_redaction
// integration specs — they POST signed events to /webhooks/billing and
// assert the controller + job pipeline.
multitenancyBillingRoutes()

router
  .group(() => {
    router.get('/ping', async ({ request, response }) => {
      const tenant = await request.tenant()
      return response.ok({ id: tenant.id, status: tenant.status })
    })

    router.get('/connection', async ({ request, response }) => {
      const tenant = await request.tenant()
      return response.ok({ connectionName: `tenant_${tenant.id}` })
    })

    // Used by request_tenant_memo integration tests
    router.get('/double-fetch', async ({ request, response }) => {
      const t1 = await request.tenant()
      const t2 = await request.tenant()
      return response.ok({ id: t1.id, sameObject: t1 === t2 })
    })

    // Used by cross_tenant_isolation integration tests. Writes/reads a
    // `posts` table that the spec provisions per-tenant (one table per
    // tenant_<uuid> schema). Proves that a request hitting tenant A's
    // schema cannot see tenant B's rows under concurrency.
    router.post('/posts', async ({ request, response }) => {
      const tenant = await request.tenant()
      const conn = db.connection(`tenant_${tenant.id}`)
      await conn.table('posts').insert({ title: request.input('title') })
      return response.ok({ ok: true, tenantId: tenant.id })
    })
    router.get('/posts', async ({ request, response }) => {
      const tenant = await request.tenant()
      const conn = db.connection(`tenant_${tenant.id}`)
      const rows = await conn.from('posts').select('id', 'title').orderBy('id')
      return response.ok({ tenantId: tenant.id, posts: rows })
    })
  })
  .prefix('tenant')
  .use(middleware.tenantGuard())

// Deliberately UNGUARDED (P2-3): proves `request.tenant()` itself fails closed
// (403) on a suspended/deleted tenant even when no guard middleware ran, and
// that `{ allowInactive: true }` is the explicit admin-flow escape hatch.
router.get('/unguarded-tenant', async ({ request, response }) => {
  const tenant = await request.tenant()
  return response.ok({ id: tenant.id, status: tenant.status })
})
router.get('/unguarded-tenant-inactive', async ({ request, response }) => {
  const tenant = await request.tenant({ allowInactive: true })
  return response.ok({ id: tenant.id, status: tenant.status })
})

// Rate-limit integration: bypassInTestEnv opts back in so the real Redis
// pipeline runs. `/strict` fails closed (503), `/open` fails open (200).
// Distinct prefixes keep parallel specs from sharing keys.
router
  .get('/rate-limited/strict', async ({ response }) => response.ok({ ok: true }))
  .use(
    middleware.rateLimit({
      limit: 3,
      windowSeconds: 2,
      prefix: 'rl-it-strict',
      bypassInTestEnv: true,
    })
  )

router
  .get('/rate-limited/open', async ({ response }) => response.ok({ ok: true }))
  .use(
    middleware.rateLimit({
      limit: 3,
      windowSeconds: 2,
      prefix: 'rl-it-open',
      bypassInTestEnv: true,
      failOpen: true,
    })
  )

// Plan-aware rate limiting: the limit comes from the resolved tenant's plan
// (config.plans.definitions[plan].rateLimit), NOT from route options.
// starter = 3/2s, pro = 10/2s. tenantGuard runs first so request.tenant()
// resolves the model that enforceRateLimit reads the plan from.
router
  .get('/rate-limited/plan', async ({ response }) => response.ok({ ok: true }))
  .use(middleware.tenantGuard())
  .use(enforceRateLimit({ prefix: 'rl-it-plan', bypassInTestEnv: true }))

// Universal route: serves both tenant and central contexts. Used by the
// universal_connection_cap integration spec to prove that when the hard
// connection cap (isolation.enforceConnectionCap) refuses a resolved tenant's
// connection, the universal middleware surfaces a 503 rather than silently
// degrading to central mode. The handler is trivial: the middleware does the
// work, so a refused connection never reaches it.
router
  .get('/universal/ping', async ({ response }) => response.ok({ ok: true }))
  .use(middleware.universal())

// Impersonation integration: echoes ctx.impersonation so the spec can
// assert the attached context end-to-end.
router
  .get('/impersonation-check', async (ctx: any) => {
    return ctx.response.ok({ impersonation: ctx.impersonation ?? null })
  })
  .use(middleware.impersonation())

// Impersonation tenant-binding integration: the tenant guard runs FIRST (it
// seeds tenancy.currentId() via TenantLogContext), then impersonation. Used by
// impersonation_tenant_binding.spec to prove a token issued for tenant A is
// rejected when presented on a request resolved to tenant B.
router
  .get('/guarded-impersonation-check', async (ctx: any) => {
    const tenant = await ctx.request.tenant()
    return ctx.response.ok({ tenantId: tenant.id, impersonation: ctx.impersonation ?? null })
  })
  .use(middleware.tenantGuard())
  .use(middleware.impersonation())

// Legacy (opt-out) mode — used by custom_domain_middleware integration tests.
// `strict: false` restores the pre-1.0 behavior where an explicit header wins
// over a matching custom domain. Secure-by-default is the bare call below.
router
  .get('/custom-domain-check', async ({ request, response }) => {
    return response.ok({ tenantId: request.header('x-tenant-id') ?? null })
  })
  .use(middleware.customDomain({ strict: false }))

// Default (secure) mode — `customDomain()` with no options is now strict.
// header_vs_domain_precedence proves a header conflicting with a registered
// custom domain is rejected (rather than silently shadowing the domain-derived
// tenant) WITHOUT having to opt in.
router
  .get('/custom-domain-strict-check', async ({ request, response }) => {
    return response.ok({ tenantId: request.header('x-tenant-id') ?? null })
  })
  .use(middleware.customDomain())
