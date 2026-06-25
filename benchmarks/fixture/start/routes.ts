import router from '@adonisjs/core/services/router'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { middleware } from './kernel.js'
import BenchNote from '../app/models/bench_note.js'
import BenchNoteScoped from '../app/models/bench_note_scoped.js'

const driver = process.env.BENCH_DRIVER ?? 'schema-pg'
const isRowScope = driver === 'rowscope-pg'

/**
 * Read the most recent notes for the active tenant. For schema-pg/database-pg
 * the TenantAdapter routes `BenchNote` to the tenant's connection from the
 * request header automatically. For rowscope-pg the scope mixin needs an active
 * `tenancy.run()` context (strict mode throws otherwise), so we open one and
 * query the shared, tenant_id-scoped table.
 */
async function readRecentNotes(tenant: any) {
  if (isRowScope) {
    return tenancy.run(tenant, () =>
      BenchNoteScoped.query().select('id', 'title').orderBy('id', 'desc').limit(20)
    )
  }
  return BenchNote.query().select('id', 'title').orderBy('id', 'desc').limit(20)
}

async function insertNote(tenant: any, title: string) {
  if (isRowScope) {
    return tenancy.run(tenant, () => BenchNoteScoped.create({ title }))
  }
  return BenchNote.create({ title })
}

// Tenant-free ceiling route: the framework's raw request/response throughput
// with none of the tenancy stack on the path.
router.get('/ceiling', async ({ response }) => response.ok({ ok: true }))
router.get('/health', async ({ response }) => response.ok({ status: 'ok' }))

// Main tenant read/write path, behind the tenant guard.
router
  .group(() => {
    router.get('/notes', async ({ request, response }) => {
      const tenant = await request.tenant()
      const notes = await readRecentNotes(tenant)
      return response.ok({ tenantId: tenant.id, notes })
    })

    router.post('/notes', async ({ request, response }) => {
      const tenant = await request.tenant()
      await insertNote(tenant, String(request.input('title', 'bench')))
      return response.ok({ ok: true, tenantId: tenant.id })
    })
  })
  .prefix('tenant')
  .use(middleware.tenantGuard())

// Same read, guard removed — diff vs /tenant/notes prices the guard middleware.
router.get('/noguard/notes', async ({ request, response }) => {
  const tenant = await request.tenant()
  const notes = await readRecentNotes(tenant)
  return response.ok({ tenantId: tenant.id, notes })
})

// Same read, guard + rate-limit — diff vs /tenant/notes prices the rate-limit
// Redis pipeline. Generous limit so the limiter never trips during a load run.
router
  .get('/ratelimited/notes', async ({ request, response }) => {
    const tenant = await request.tenant()
    const notes = await readRecentNotes(tenant)
    return response.ok({ tenantId: tenant.id, notes })
  })
  .use([
    middleware.tenantGuard(),
    middleware.rateLimit({ limit: 1_000_000, windowSeconds: 60, prefix: 'bench-rl' }),
  ])
