import router from '@adonisjs/core/services/router'
import db from '@adonisjs/lucid/services/db'
import { middleware } from './kernel.js'
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'

router.get('/health', async ({ response }) => {
  return response.ok({ status: 'ok' })
})

// Mount admin REST + OpenAPI docs without auth — the fixture is for tests
// only, and individual specs supply their own ad-hoc gating where needed.
// `middleware: false` is the explicit opt-out the package now requires.
multitenancyAdminRoutes({ prefix: '/admin/multitenancy', middleware: false })

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

// Impersonation integration: echoes ctx.impersonation so the spec can
// assert the attached context end-to-end.
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
