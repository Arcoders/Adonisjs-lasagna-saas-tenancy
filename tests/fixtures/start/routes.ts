import router from '@adonisjs/core/services/router'
import db from '@adonisjs/lucid/services/db'
import { middleware } from './kernel.js'
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/saas-tenancy/admin'

router.get('/health', async ({ response }) => {
  return response.ok({ status: 'ok' })
})

// Mount admin REST + OpenAPI docs without auth — the fixture is for tests
// only, and individual specs supply their own ad-hoc gating where needed.
multitenancyAdminRoutes({ prefix: '/admin/multitenancy' })

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
