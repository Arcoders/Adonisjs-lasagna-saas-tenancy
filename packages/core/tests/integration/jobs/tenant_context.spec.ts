import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { IsolationDriverRegistry, SchemaPgDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

const TENANT_COUNT = 3
const JOBS_PER_TENANT = 30

/**
 * S0-3 (case 4.2): the job-context isolation test.
 *
 * Real BullMQ workers wrap each job invocation with `tenancy.run(tenant,
 * fn)` so `currentId()` resolves to the right tenant. This spec
 * exercises the same primitive directly under maximal interleaving:
 * we synthesize hundreds of "jobs" (callbacks wrapped in
 * tenancy.run), fire them concurrently across multiple tenants, and
 * assert that:
 *
 *   1. Inside each callback, `tenancy.currentId()` matches the
 *      tenant the job was started for. (AsyncLocalStorage isolation.)
 *   2. After all jobs complete, each tenant's schema contains
 *      exactly the rows that belong to its own jobs — no cross-bleed.
 *
 * If either fails, jobs running in production can corrupt
 * cross-tenant data; the package is unsafe to ship.
 */
test.group('tenancy.run() — job context propagation under concurrency', (group) => {
  let driver: SchemaPgDriver
  const tenantRecords: { id: string; index: number; model: TenantModelContract }[] = []

  async function findTenant(id: string): Promise<TenantModelContract> {
    const Tenant = (await import('../../fixtures/app/models/tenant.js')).default
    const t = await Tenant.find(id)
    if (!t) throw new Error(`tenant ${id} not found`)
    return t as unknown as TenantModelContract
  }

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(`Job context tests require schema-pg driver (got '${active.name}')`)
    }
    driver = active as SchemaPgDriver

    for (let i = 0; i < TENANT_COUNT; i++) {
      const t = await createTestTenant({ status: 'active' })
      const model = await findTenant(t.id)
      await driver.provision(model)
      await db.connection(`tenant_${t.id}`).rawQuery(`
        CREATE TABLE jobs_log (
          id        serial PRIMARY KEY,
          marker    text NOT NULL,
          tenant_id text NOT NULL
        )
      `)
      tenantRecords.push({ id: t.id, index: i, model })
    }
  })

  group.teardown(async () => {
    while (tenantRecords.length) {
      const t = tenantRecords.pop()!
      await driver.destroy({ id: t.id } as any).catch(() => {})
      await destroyTestTenant(t.id).catch(() => {})
    }
  })

  test('tenancy.currentId() and per-schema writes are correctly scoped under high concurrency', async ({
    assert,
  }) => {
    type Job = { tenantIndex: number; jobIndex: number }
    const jobs: Job[] = []
    for (const t of tenantRecords) {
      for (let j = 0; j < JOBS_PER_TENANT; j++) {
        jobs.push({ tenantIndex: t.index, jobIndex: j })
      }
    }
    // Shuffle so the runtime cannot accidentally serialize same-tenant jobs.
    for (let i = jobs.length - 1; i > 0; i--) {
      const k = Math.floor(Math.random() * (i + 1))
      ;[jobs[i], jobs[k]] = [jobs[k], jobs[i]]
    }

    // Track ALS leaks: any (jobId, observedTenantId, expectedTenantId)
    // mismatch goes here.
    const alsViolations: { job: Job; observed: string | undefined; expected: string }[] = []

    await Promise.all(
      jobs.map((job) => {
        const t = tenantRecords[job.tenantIndex]
        return tenancy.run(t.model, async () => {
          // ALS check: the observed currentId must equal `t.id`. If it
          // doesn't, AsyncLocalStorage is bleeding contexts.
          const observed = tenancy.currentId()
          if (observed !== t.id) {
            alsViolations.push({ job, observed, expected: t.id })
            return
          }

          // Persist a marker into THIS tenant's schema, with the
          // tenant_id stored as a column. If the connection routing
          // breaks, the row will land in another schema and the
          // subsequent assertion will catch it.
          await db
            .connection(`tenant_${t.id}`)
            .table('jobs_log')
            .insert({
              marker: `t${job.tenantIndex}-j${job.jobIndex}`,
              tenant_id: t.id,
            })
        })
      })
    )

    assert.lengthOf(
      alsViolations,
      0,
      `ALS leak: tenancy.currentId() returned the wrong tenant in ${alsViolations.length} jobs. ` +
        `Sample: ${JSON.stringify(alsViolations.slice(0, 3))}`
    )

    // Per-schema verification: each tenant's jobs_log must contain
    // exactly its own markers, no cross-tenant rows.
    for (const t of tenantRecords) {
      const rows = await db.connection(`tenant_${t.id}`).from('jobs_log').select('*')
      assert.equal(
        rows.length,
        JOBS_PER_TENANT,
        `tenant ${t.id} schema must hold ${JOBS_PER_TENANT} markers, got ${rows.length}`
      )
      for (const row of rows) {
        assert.equal(
          row.tenant_id,
          t.id,
          `tenant_${t.id}.jobs_log contains a row with tenant_id=${row.tenant_id} from another tenant`
        )
        assert.match(row.marker, new RegExp(`^t${t.index}-j\\d+$`))
      }
    }
  })

  test('currentId() is undefined outside any tenancy.run() scope', async ({ assert }) => {
    assert.isUndefined(
      tenancy.currentId(),
      'currentId must not bleed past the end of a run() scope'
    )
  })

  test('nested tenancy.run() restores the outer tenant on exit', async ({ assert }) => {
    const [outer, inner] = tenantRecords
    let observedInner: string | undefined
    let observedOuterAfter: string | undefined

    await tenancy.run(outer.model, async () => {
      assert.equal(tenancy.currentId(), outer.id)
      await tenancy.run(inner.model, async () => {
        observedInner = tenancy.currentId()
      })
      observedOuterAfter = tenancy.currentId()
    })

    assert.equal(observedInner, inner.id, 'inner scope must report inner tenant')
    assert.equal(
      observedOuterAfter,
      outer.id,
      'outer scope must be restored after the inner scope returns'
    )
  })
})
