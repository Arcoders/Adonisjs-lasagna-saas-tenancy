import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { IsthmusGuardTripped } from '@adonisjs-lasagna/saas-tenancy/events'
import { snapshotIsthmusCounters } from '@adonisjs-lasagna/saas-tenancy/internal'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * ContextSeal under concurrency: a shuffled, interleaved mix of mismatch and
 * agree requests must keep per-request isolation — every mismatch fails closed
 * (500), every agree succeeds (200) with its OWN tenant's data, and the memo on
 * one request never contaminates another. DELTA-only (shared process, no reset
 * seam on /internal): assert the rejected{seal.tenant_context} increase equals
 * the mismatch count.
 */

const MISMATCH = 30
const AGREE = 30

async function findTenant(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
  const t = await Tenant.find(id)
  if (!t) throw new Error(`tenant ${id} not found`)
  return t as unknown as TenantModelContract
}

function rejectedContext(): number {
  return snapshotIsthmusCounters().rejected.find((r) => r.id === 'seal.tenant_context')?.value ?? 0
}

test.group('ContextSeal — concurrent mismatch/agree fuzz', (group) => {
  let driver: SchemaPgDriver
  let tenantA: { id: string }
  let tenantB: { id: string }

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    driver = reg.active() as SchemaPgDriver

    tenantA = await createTestTenant({ status: 'active' })
    await driver.provision(await findTenant(tenantA.id))
    await db.connection(`tenant_${tenantA.id}`).rawQuery(`
      CREATE TABLE posts (
        id    serial PRIMARY KEY,
        title text NOT NULL
      )
    `)
    // B exists in the registry; the seal refuses before routing to its schema.
    tenantB = await createTestTenant({ status: 'active' })
  })

  group.teardown(async () => {
    await driver.destroy({ id: tenantA.id } as any).catch(() => {})
    await destroyTestTenant(tenantA.id).catch(() => {})
    await destroyTestTenant(tenantB.id).catch(() => {})
  })

  test('interleaved mismatch + agree requests each resolve independently', async ({
    client,
    assert,
  }) => {
    const tripped: InstanceType<typeof IsthmusGuardTripped>[] = []
    const emitter = await app.container.make('emitter')
    const listener = (e: InstanceType<typeof IsthmusGuardTripped>) => {
      if (e.payload.event === 'isthmus:seal:tenant:mismatch') tripped.push(e)
    }
    emitter.on(IsthmusGuardTripped, listener)

    const rejectedBefore = rejectedContext()

    // Build the work list, then Fisher-Yates shuffle for non-deterministic
    // interleaving (index-derived seed, no Math.random needed for the shuffle
    // key: we rotate a step so the order is deterministic-yet-mixed).
    type Job = { kind: 'mismatch' | 'agree' }
    const jobs: Job[] = [
      ...Array.from({ length: MISMATCH }, () => ({ kind: 'mismatch' as const })),
      ...Array.from({ length: AGREE }, () => ({ kind: 'agree' as const })),
    ]
    for (let i = jobs.length - 1; i > 0; i--) {
      const j = (i * 7 + 3) % (i + 1)
      ;[jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!]
    }

    // Bounded concurrency: run in chunks of 10 in flight.
    const CONCURRENCY = 10
    const run = (job: Job) =>
      job.kind === 'mismatch'
        ? client
            .get('/context-seal/mismatch')
            .header('x-tenant-id', tenantA.id)
            .header('x-other-tenant-id', tenantB.id)
        : client.get('/context-seal/query').header('x-tenant-id', tenantA.id)

    const results: Array<{ kind: Job['kind']; status: number; body: any }> = []
    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
      const batch = jobs.slice(i, i + CONCURRENCY)
      const responses = await Promise.all(batch.map(run))
      responses.forEach((res, k) =>
        results.push({ kind: batch[k]!.kind, status: res.status(), body: res.body() })
      )
    }

    await new Promise<void>((resolve) => setImmediate(resolve))
    emitter.off(IsthmusGuardTripped, listener)

    // Every mismatch fails closed; every agree serves tenant A only.
    for (const r of results) {
      if (r.kind === 'mismatch') {
        assert.equal(r.status, 500, 'a context mismatch must fail closed')
      } else {
        assert.equal(r.status, 200, 'an agreeing request must succeed')
        assert.equal(r.body.tenantId, tenantA.id, 'no cross-request memo contamination')
      }
    }

    assert.equal(
      rejectedContext() - rejectedBefore,
      MISMATCH,
      'exactly one seal.tenant_context rejection per mismatch request'
    )
    assert.isAtLeast(tripped.length, 1, 'the mismatch is observable via the event')
  }).timeout(60_000)
})
