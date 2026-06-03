import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { RowScopePgDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import { tenancy, withTenantScope, unscoped } from '@adonisjs-lasagna/saas-tenancy'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { randomUUID } from 'node:crypto'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

const SHARED_TABLE = 'lasagna_rowscope_test_posts'

function fakeTenant(id: string): TenantModelContract {
  return { id, name: `rs-${id}` } as unknown as TenantModelContract
}

class TestPost extends withTenantScope(BaseModel) {
  static table = SHARED_TABLE
  @column({ isPrimary: true }) declare id: number
  @column() declare title: string
  @column() declare tenant_id: string
}

test.group('RowScopePgDriver + withTenantScope (integration)', (group) => {
  group.setup(async () => {
    // Use the public/central connection since rowscope means "shared db".
    await db.rawQuery(`
      CREATE TABLE IF NOT EXISTS ${SHARED_TABLE} (
        id serial PRIMARY KEY,
        title text NOT NULL,
        tenant_id text NOT NULL
      )
    `)
  })

  group.teardown(async () => {
    await db.rawQuery(`DROP TABLE IF EXISTS ${SHARED_TABLE}`)
  })

  group.each.setup(async () => {
    await db.rawQuery(`TRUNCATE ${SHARED_TABLE}`)
  })

  test('destroy issues DELETE WHERE tenant_id for every configured table', async ({ assert }) => {
    const driver = new RowScopePgDriver({
      centralConnectionName: 'public',
      scopedTables: [SHARED_TABLE],
    })

    const tenantA = randomUUID()
    const tenantB = randomUUID()

    await db
      .connection('public')
      .table(SHARED_TABLE)
      .multiInsert([
        { title: 'a1', tenant_id: tenantA },
        { title: 'a2', tenant_id: tenantA },
        { title: 'b1', tenant_id: tenantB },
      ])

    await driver.destroy(fakeTenant(tenantA))

    const remaining = await db.connection('public').from(SHARED_TABLE).select('*')
    assert.lengthOf(remaining, 1, 'tenantB rows must survive')
    assert.equal(remaining[0].tenant_id, tenantB)
  })

  test('connect returns the central connection (no per-tenant pool)', async ({ assert }) => {
    const driver = new RowScopePgDriver({ centralConnectionName: 'public' })
    const tenantA = fakeTenant(randomUUID())
    const tenantB = fakeTenant(randomUUID())

    const connA = await driver.connect(tenantA)
    const connB = await driver.connect(tenantB)

    // Lucid wraps the underlying pool with a fresh QueryClient instance
    // per call, so === is too strict — what we care about is that BOTH
    // tenants resolve to the same connection NAME (= same pool). That's
    // the rowscope contract: no per-tenant connection.
    assert.equal((connA as any).connectionName, 'public')
    assert.equal((connB as any).connectionName, 'public')
    assert.equal(
      (connA as any).connectionName,
      (connB as any).connectionName,
      'both tenants must share the central connection — no per-tenant pool'
    )

    // And the client must actually work — a noop query exercises the
    // pool path Lucid sets up under the hood.
    const result = await connA.rawQuery('SELECT 1 as one')
    const rows = Array.isArray(result.rows) ? result.rows : (result as any).rows
    assert.equal(Number(rows[0].one), 1)
  })

  test('migrate is a no-op (returns { executed: 0, noop: true })', async ({ assert }) => {
    const driver = new RowScopePgDriver()
    const result = await driver.migrate(fakeTenant(randomUUID()), {} as any)
    assert.deepEqual(result, { executed: 0, noop: true })
  })

  test('rejects unsafe rowScopeTables values at construction time', ({ assert }) => {
    assert.throws(
      () => new RowScopePgDriver({ scopedTables: ['ok_table; DROP TABLE x;--'] }),
      /Refusing to use unsafe/
    )
  })
})

test.group('withTenantScope mixin (integration)', (group) => {
  group.setup(async () => {
    await db.rawQuery(`
      CREATE TABLE IF NOT EXISTS ${SHARED_TABLE} (
        id serial PRIMARY KEY,
        title text NOT NULL,
        tenant_id text NOT NULL
      )
    `)
    TestPost.boot()
  })

  group.teardown(async () => {
    await db.rawQuery(`DROP TABLE IF EXISTS ${SHARED_TABLE}`)
  })

  group.each.setup(async () => {
    await db.rawQuery(`TRUNCATE ${SHARED_TABLE}`)
  })

  test('create auto-fills tenant_id from the active scope', async ({ assert }) => {
    const tenantId = randomUUID()
    await tenancy.run(fakeTenant(tenantId), async () => {
      const post = await TestPost.create({ title: 'hello' })
      assert.equal(post.tenant_id, tenantId)
    })
  })

  test('fetch hook filters by the active tenant', async ({ assert }) => {
    const tenantA = randomUUID()
    const tenantB = randomUUID()

    await tenancy.run(fakeTenant(tenantA), async () => {
      await TestPost.create({ title: 'a' })
    })
    await tenancy.run(fakeTenant(tenantB), async () => {
      await TestPost.create({ title: 'b' })
    })

    await tenancy.run(fakeTenant(tenantA), async () => {
      const posts = await TestPost.all()
      assert.lengthOf(posts, 1)
      assert.equal(posts[0].title, 'a')
    })
  })

  test('grouped OR branches keep the tenant scope (the safe pattern)', async ({ assert }) => {
    const tenantA = randomUUID()
    const tenantB = randomUUID()

    await tenancy.run(fakeTenant(tenantA), async () => {
      await TestPost.create({ title: 'a1' })
    })
    await tenancy.run(fakeTenant(tenantB), async () => {
      // Same title that tenant A's query will OR on — a leak would surface it.
      await TestPost.create({ title: 'mid' })
    })

    await tenancy.run(fakeTenant(tenantA), async () => {
      const rows = await TestPost.query().where((q) =>
        q.where('title', 'a1').orWhere('title', 'mid').orWhere('title', 'zzz')
      )
      // (a1 OR mid OR zzz) AND tenant_id = A → only tenant A's a1.
      assert.lengthOf(rows, 1)
      assert.isTrue(
        rows.every((r) => r.tenant_id === tenantA),
        'grouped OR must not leak another tenant rows'
      )
    })
  })

  test('unscoped() returns rows from every tenant', async ({ assert }) => {
    const tenantA = randomUUID()
    const tenantB = randomUUID()

    await tenancy.run(fakeTenant(tenantA), async () => {
      await TestPost.create({ title: 'a1' })
    })
    await tenancy.run(fakeTenant(tenantB), async () => {
      await TestPost.create({ title: 'b1' })
    })

    const all = await unscoped(() => TestPost.all())
    assert.lengthOf(all, 2)
  })

  test('strict mode throws when a query runs without tenancy.run() and without unscoped()', async ({
    assert,
  }) => {
    await assert.rejects(() => TestPost.all(), /MissingTenantScopeException|outside both/)
  })

  test('bulk delete via query builder is scoped (Lucid fires before:fetch)', async ({ assert }) => {
    const tenantA = randomUUID()
    const tenantB = randomUUID()

    await tenancy.run(fakeTenant(tenantA), async () => {
      await TestPost.create({ title: 'a1' })
      await TestPost.create({ title: 'a2' })
    })
    await tenancy.run(fakeTenant(tenantB), async () => {
      await TestPost.create({ title: 'b1' })
    })

    await tenancy.run(fakeTenant(tenantA), async () => {
      await TestPost.query().delete()
    })

    const survivors = await unscoped(() => TestPost.all())
    assert.lengthOf(survivors, 1)
    assert.equal(survivors[0].tenant_id, tenantB)
  })
})
