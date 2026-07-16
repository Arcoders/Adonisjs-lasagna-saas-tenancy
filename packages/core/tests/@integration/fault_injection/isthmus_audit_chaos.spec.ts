import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { IsthmusGuardTripped } from '@adonisjs-lasagna/saas-tenancy/events'
import { emitIsthmusEvent, snapshotIsthmusCounters } from '@adonisjs-lasagna/saas-tenancy/internal'
import { createTestTenant, destroyTestTenant } from '../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Fault-injection tier (non-gating): the Isthmus audit path under a hostile
 * emitter and under sustained load. The invariant it defends: the reject path is
 * decoupled from the audit path. A blocking or throwing listener cannot delay or
 * break an HTTP response, and a flood cannot exhaust anything but its own
 * per-severity dispatch budget (every drop still counted).
 *
 * Imports follow the @integration convention (public subpaths resolve to the
 * compiled build), so the in-process trips bump the SAME counter instance the
 * booted app reads.
 */

const LISTENER_DELAY_MS = 2000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function findTenant(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../fixtures/app/models/tenant.js')).default
  const t = await Tenant.find(id)
  if (!t) throw new Error(`tenant ${id} not found`)
  return t as unknown as TenantModelContract
}

test.group('Isthmus audit chaos (fault injection)', (group) => {
  let driver: SchemaPgDriver
  let tenantA: { id: string }
  let tenantB: { id: string }

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    driver = reg.active() as SchemaPgDriver
    tenantA = await createTestTenant({ status: 'active' })
    await driver.provision(await findTenant(tenantA.id))
    await db.connection(`tenant_${tenantA.id}`).rawQuery(`
      CREATE TABLE posts (id serial PRIMARY KEY, title text NOT NULL)
    `)
    tenantB = await createTestTenant({ status: 'active' })
  })

  group.teardown(async () => {
    await driver.destroy({ id: tenantA.id } as any).catch(() => {})
    await destroyTestTenant(tenantA.id).catch(() => {})
    await destroyTestTenant(tenantB.id).catch(() => {})
  })

  test('a 2s-blocking listener does not delay the HTTP response (fire-and-forget)', async ({
    client,
    assert,
  }) => {
    const emitter = await app.container.make('emitter')
    const listener = async () => {
      await sleep(LISTENER_DELAY_MS)
    }
    emitter.on(IsthmusGuardTripped, listener)

    try {
      const start = Date.now()
      const res = await client
        .get('/context-seal/mismatch')
        .header('x-tenant-id', tenantA.id)
        .header('x-other-tenant-id', tenantB.id)
      const elapsed = Date.now() - start

      res.assertStatus(500)
      assert.isBelow(
        elapsed,
        1500,
        `the response must not wait on the ${LISTENER_DELAY_MS}ms listener (took ${elapsed}ms)`
      )
    } finally {
      // Let the slow listener settle so it doesn't leak into the next test.
      await sleep(LISTENER_DELAY_MS + 100)
      emitter.off(IsthmusGuardTripped, listener)
    }
  }).timeout(15_000)

  test('a throwing listener leaves the HTTP response and the process unharmed', async ({
    client,
    assert,
  }) => {
    const emitter = await app.container.make('emitter')
    const listener = () => {
      throw new Error('listener boom')
    }
    emitter.on(IsthmusGuardTripped, listener)

    try {
      const res = await client
        .get('/context-seal/mismatch')
        .header('x-tenant-id', tenantA.id)
        .header('x-other-tenant-id', tenantB.id)
      res.assertStatus(500)

      await new Promise<void>((resolve) => setImmediate(resolve))
      // A follow-up request still works. The process survived the throw.
      const ok = await client.get('/context-seal/query').header('x-tenant-id', tenantA.id)
      ok.assertStatus(200)
    } finally {
      emitter.off(IsthmusGuardTripped, listener)
    }
  }).timeout(15_000)

  test('a sustained trip flood caps dispatch at the budget and counts every drop', async ({
    assert,
  }) => {
    // warn budget is 50 per 10s window. Fire 500 in-process warn trips through
    // the build instance; the conservation identity holds regardless of whether
    // the run crosses a window boundary.
    const ID = 'guard.metric_value' // warn
    const N = 500

    const before = snapshotIsthmusCounters()
    const guardedBefore = before.guarded
      .filter((g) => g.severity === 'warn')
      .reduce((s, g) => s + g.value, 0)
    const droppedBefore = before.dropped
      .filter((d) => d.severity === 'warn' && d.reason === 'rate_limited')
      .reduce((s, d) => s + d.value, 0)

    for (let i = 0; i < N; i++) emitIsthmusEvent(ID)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const after = snapshotIsthmusCounters()
    const guardedDelta =
      after.guarded.filter((g) => g.severity === 'warn').reduce((s, g) => s + g.value, 0) -
      guardedBefore
    const droppedDelta =
      after.dropped
        .filter((d) => d.severity === 'warn' && d.reason === 'rate_limited')
        .reduce((s, d) => s + d.value, 0) - droppedBefore

    assert.equal(guardedDelta, N, 'every trip is counted (counters-first, never rate-limited)')
    // Magnitude check without boundary flakiness: most of the flood is dropped.
    assert.isAtLeast(droppedDelta, N - 100, 'the flood is shed past the per-severity budget')

    const noEmitterDelta =
      after.dropped.filter((d) => d.reason === 'no_emitter').reduce((s, d) => s + d.value, 0) -
      before.dropped.filter((d) => d.reason === 'no_emitter').reduce((s, d) => s + d.value, 0)
    assert.equal(noEmitterDelta, 0, 'a booted app dispatches cleanly — no emitter drops')
  }).timeout(15_000)
})
