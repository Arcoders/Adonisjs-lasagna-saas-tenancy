import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { mapTenants, resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

async function makeTenants(n: number, cleanup: string[]): Promise<TenantModelContract[]> {
  const repo = await resolveTenantRepository()
  const models: TenantModelContract[] = []
  for (let i = 0; i < n; i++) {
    const t = await createTestTenant({ status: 'active' })
    cleanup.push(t.id)
    const model = await repo.findById(t.id)
    models.push(model!)
  }
  return models
}

test.group('mapTenants (integration)', (group) => {
  const cleanup: string[] = []
  group.each.teardown(async () => {
    while (cleanup.length) await destroyTestTenant(cleanup.pop()!).catch(() => {})
  })

  test('runs fn inside each tenant scope (currentId matches)', async ({ assert }) => {
    const tenants = await makeTenants(3, cleanup)
    const { results, errors } = await mapTenants(tenants, async () => tenancy.currentId())
    assert.lengthOf(errors, 0)
    assert.lengthOf(results, 3)
    for (const r of results) {
      assert.equal(r.value, r.tenantId, 'tenancy.currentId() inside fn === the tenant being mapped')
    }
  }).timeout(60_000)

  test('isolates a failing tenant, others still succeed (continueOnError default)', async ({
    assert,
  }) => {
    const tenants = await makeTenants(3, cleanup)
    const bad = tenants[1].id
    const { results, errors } = await mapTenants(tenants, async (t) => {
      if (t.id === bad) throw new Error('tenant blew up')
      return 'ok'
    })
    assert.lengthOf(results, 2)
    assert.lengthOf(errors, 1)
    assert.equal(errors[0].tenantId, bad)
    assert.match(errors[0].error.message, /blew up/)
  }).timeout(60_000)

  test('continueOnError:false rejects on the first failure', async ({ assert }) => {
    const tenants = await makeTenants(3, cleanup)
    await assert.rejects(
      () =>
        mapTenants(
          tenants,
          async (t) => {
            if (t.id === tenants[0].id) throw new Error('hard-stop')
            return 'ok'
          },
          { continueOnError: false }
        ),
      /hard-stop/
    )
  }).timeout(60_000)

  test('bounded concurrency completes and does not exhaust the pool', async ({ assert }) => {
    const tenants = await makeTenants(4, cleanup)
    const { results, errors } = await mapTenants(
      tenants,
      async () => {
        // a trivial tenant-scoped read
        const r = await db.connection().rawQuery('SELECT 1 AS ok')
        return (r.rows?.[0]?.ok ?? r[0]?.ok) as number
      },
      { concurrency: 2 }
    )
    assert.lengthOf(errors, 0)
    assert.lengthOf(results, 4)
    // a follow-up backoffice query still works → the pool was not exhausted
    const after = await db.connection('backoffice').rawQuery('SELECT 1 AS ok')
    assert.equal(Number(after.rows?.[0]?.ok ?? 1), 1)
  }).timeout(90_000)

  test('empty tenant list → empty result', async ({ assert }) => {
    const out = await mapTenants([], async () => 1)
    assert.deepEqual(out, { results: [], errors: [] })
  })
})
