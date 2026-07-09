import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { tenancy, withTenantScope } from '@adonisjs-lasagna/saas-tenancy'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { randomUUID } from 'node:crypto'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * WS-9 / rowscope-mixin-no-concurrency-test.
 *
 * `schema-pg` has a load-bearing concurrent cross-tenant proof
 * (cross_tenant_fuzz.spec.ts), but `rowscope-pg` — which shares ONE connection
 * across all tenants and relies on the AsyncLocalStorage scope from
 * `tenancy.run()` to stamp/filter `tenant_id` — had only sequential coverage.
 * If that ALS scope ever bled across concurrently-interleaved `tenancy.run()`
 * calls, a create would stamp the wrong tenant_id and a read would surface
 * another tenant's rows. This drives many tenants writing AND reading
 * concurrently on the shared connection and asserts perfect partitioning.
 *
 * RED (pre-fix): no concurrent rowscope proof existed.
 */
const SHARED_TABLE = 'lasagna_rowscope_concurrent_posts'
const TENANTS = 10
const WRITES_PER_TENANT = 25

function fakeTenant(id: string): TenantModelContract {
  return { id, name: `rs-${id}` } as unknown as TenantModelContract
}

class CPost extends withTenantScope(BaseModel) {
  static table = SHARED_TABLE
  @column({ isPrimary: true }) declare id: number
  @column() declare title: string
  @column() declare tenant_id: string
}

test.group('rowscope-pg cross-tenant concurrency (integration)', (group) => {
  group.setup(async () => {
    await db.rawQuery(`
      CREATE TABLE IF NOT EXISTS ${SHARED_TABLE} (
        id serial PRIMARY KEY,
        title text NOT NULL,
        tenant_id text NOT NULL
      )
    `)
    CPost.boot()
  })

  group.teardown(async () => {
    await db.rawQuery(`DROP TABLE IF EXISTS ${SHARED_TABLE}`)
  })

  group.each.setup(async () => {
    await db.rawQuery(`TRUNCATE ${SHARED_TABLE}`)
  })

  test('interleaved writes across tenants stamp the correct tenant_id every time', async ({
    assert,
  }) => {
    const ids = Array.from({ length: TENANTS }, () => randomUUID())

    // Run every tenant's write loop concurrently. Each iteration awaits a real
    // INSERT, so the scopes interleave on the shared connection — exactly the
    // race that would surface an ALS scope bleed.
    await Promise.all(
      ids.map((id, t) =>
        tenancy.run(fakeTenant(id), async () => {
          for (let i = 0; i < WRITES_PER_TENANT; i++) {
            // Title encodes the OWNING tenant index + row, so a mis-stamped
            // tenant_id is detectable by cross-referencing title vs tenant_id.
            const post = await CPost.create({ title: `t${t}-r${i}` })
            assert.equal(
              post.tenant_id,
              id,
              `create must stamp the active tenant id, not a bled-in one (t${t} r${i})`
            )
          }
        })
      )
    )

    // Ground truth from a raw read (bypasses the model scope entirely): every
    // tenant has exactly its own rows, and no row's title disagrees with its
    // tenant_id.
    const all = await db.connection('public').from(SHARED_TABLE).select('*')
    assert.lengthOf(all, TENANTS * WRITES_PER_TENANT, 'no writes lost or duplicated')

    const byTenant = new Map<string, number>()
    for (const row of all) {
      byTenant.set(row.tenant_id, (byTenant.get(row.tenant_id) ?? 0) + 1)
      const owner = ids[Number(String(row.title).match(/^t(\d+)-/)![1])]
      assert.equal(row.tenant_id, owner, `row "${row.title}" stamped to the wrong tenant`)
    }
    for (const id of ids) {
      assert.equal(byTenant.get(id), WRITES_PER_TENANT, `tenant ${id} must own exactly its rows`)
    }
  })

  test('concurrent scoped reads each see only the active tenant rows', async ({ assert }) => {
    const ids = Array.from({ length: TENANTS }, () => randomUUID())

    // Seed each tenant sequentially so the dataset is unambiguous.
    for (let t = 0; t < TENANTS; t++) {
      await tenancy.run(fakeTenant(ids[t]!), async () => {
        for (let i = 0; i < WRITES_PER_TENANT; i++) {
          await CPost.create({ title: `t${t}-r${i}` })
        }
      })
    }

    // Now read every tenant's rows concurrently through the scoped fetch hook.
    const results = await Promise.all(
      ids.map((id) =>
        tenancy.run(fakeTenant(id), async () => {
          const rows = await CPost.all()
          return { id, rows }
        })
      )
    )

    for (const { id, rows } of results) {
      assert.lengthOf(rows, WRITES_PER_TENANT, `tenant ${id} read must be its own rows only`)
      assert.isTrue(
        rows.every((r) => r.tenant_id === id),
        `tenant ${id} concurrent read leaked another tenant's rows`
      )
    }
  })
})
