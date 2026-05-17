import router from '@adonisjs/core/services/router'
import db from '@adonisjs/lucid/services/db'
import { middleware } from './kernel.js'
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/saas-tenancy/admin'
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/saas-tenancy/health'

router.get('/health', async ({ response }) => {
  return response.ok({ status: 'ok' })
})

// Mount admin REST + OpenAPI docs without auth — the fixture is for tests
// only, and individual specs supply their own ad-hoc gating where needed.
multitenancyAdminRoutes({ prefix: '/admin/multitenancy' })

// Mount the Stripe webhook receiver. Required by the dunning_flow,
// webhook_idempotency, ip_allowlist (HTTP variant), and pii_redaction
// integration specs — they POST signed events to /webhooks/stripe and
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

// Used by `rate_limit_middleware` integration spec. The middleware
// short-circuits when `app.inTest` is true unless `bypassInTestEnv` is
// set — we explicitly opt in here so the integration suite exercises
// the real Redis pipeline. A short window (2s) keeps the recovery
// assertion fast.
//
// `/rate-limited` is a normal tenant-scoped route so `resolveTenantId`
// picks up the `x-tenant-id` header; the limit applies per (tenant, ip)
// pair via the key the middleware computes (`<prefix>:<tenant>:<ip>`).
// `/strict` is fail-closed (Redis outage → 503); `/open` is fail-open
// (Redis outage → 200). Both use distinct prefixes so test runs do not
// contaminate each other.
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

// Used by `impersonation_middleware` integration spec. The middleware
// reads `x-impersonation-token` (or `__impersonation` cookie), verifies
// via `ImpersonationService`, and attaches `ctx.impersonation`. We
// surface that on the response body so the spec can assert it end-to-end.
router
  .get('/impersonation-check', async (ctx: any) => {
    return ctx.response.ok({ impersonation: ctx.impersonation ?? null })
  })
  .use(middleware.impersonation())

// Used by custom_domain_middleware integration tests
router
  .get('/custom-domain-check', async ({ request, response }) => {
    return response.ok({ tenantId: request.header('x-tenant-id') ?? null })
  })
  .use(middleware.customDomain())

// Same handler under strict mode — used by header_vs_domain_precedence
// to prove that a header conflicting with a registered custom domain is
// rejected (rather than silently shadowing the domain-derived tenant).
router
  .get('/custom-domain-strict-check', async ({ request, response }) => {
    return response.ok({ tenantId: request.header('x-tenant-id') ?? null })
  })
  .use(middleware.customDomain({ strict: true }))
