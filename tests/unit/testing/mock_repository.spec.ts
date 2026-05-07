import { test } from '@japa/runner'
import { mockTenantRepository } from '../../../src/testing/mock_repository.js'
import { buildTestTenant } from '../../../src/testing/builders.js'
import { setupTestConfig } from '../../helpers/config.js'

test.group('MockTenantRepository — basic queries', (group) => {
  group.each.setup(() => setupTestConfig())

  test('findById returns null for unknown id', async ({ assert }) => {
    const repo = mockTenantRepository()
    assert.isNull(await repo.findById('missing'))
  })

  test('findById returns the seeded tenant', async ({ assert }) => {
    const tenant = buildTestTenant({ id: '11111111-1111-4111-8111-111111111111' })
    const repo = mockTenantRepository([tenant])
    const found = await repo.findById(tenant.id)
    assert.strictEqual(found, tenant)
  })

  test('findByIdOrFail throws when missing', async ({ assert }) => {
    const repo = mockTenantRepository()
    await assert.rejects(() => repo.findByIdOrFail('missing'), /tenant "missing" not found/)
  })

  test('findById hides soft-deleted by default but reveals with includeDeleted', async ({ assert }) => {
    const { DateTime } = await import('luxon')
    const tenant = buildTestTenant({ deletedAt: DateTime.now() })
    const repo = mockTenantRepository([tenant])

    assert.isNull(await repo.findById(tenant.id))
    assert.strictEqual(await repo.findById(tenant.id, true), tenant)
  })

  test('findByDomain matches active tenants', async ({ assert }) => {
    const t1 = buildTestTenant({ customDomain: 'acme.test' })
    const t2 = buildTestTenant({ customDomain: 'beta.test' })
    const repo = mockTenantRepository([t1, t2])
    assert.strictEqual(await repo.findByDomain('beta.test'), t2)
    assert.isNull(await repo.findByDomain('unknown.test'))
  })
})

test.group('MockTenantRepository — listing', (group) => {
  group.each.setup(() => setupTestConfig())

  test('all() omits soft-deleted by default', async ({ assert }) => {
    const { DateTime } = await import('luxon')
    const t1 = buildTestTenant()
    const t2 = buildTestTenant({ deletedAt: DateTime.now() })
    const repo = mockTenantRepository([t1, t2])
    const list = await repo.all()
    assert.lengthOf(list, 1)
    assert.strictEqual(list[0], t1)
  })

  test('all({ includeDeleted: true }) returns everything', async ({ assert }) => {
    const { DateTime } = await import('luxon')
    const t1 = buildTestTenant()
    const t2 = buildTestTenant({ deletedAt: DateTime.now() })
    const repo = mockTenantRepository([t1, t2])
    const list = await repo.all({ includeDeleted: true })
    assert.lengthOf(list, 2)
  })

  test('all({ statuses }) filters by status', async ({ assert }) => {
    const active = buildTestTenant({ status: 'active' })
    const suspended = buildTestTenant({ status: 'suspended' })
    const repo = mockTenantRepository([active, suspended])
    const list = await repo.all({ statuses: ['suspended'] })
    assert.deepEqual(
      list.map((t) => t.id),
      [suspended.id]
    )
  })

  test('whereIn returns intersection with provided ids', async ({ assert }) => {
    const t1 = buildTestTenant()
    const t2 = buildTestTenant()
    const t3 = buildTestTenant()
    const repo = mockTenantRepository([t1, t2, t3])
    const list = await repo.whereIn([t1.id, t3.id, 'missing'])
    assert.deepEqual(
      list.map((t) => t.id).sort(),
      [t1.id, t3.id].sort()
    )
  })
})

test.group('MockTenantRepository — mutations', (group) => {
  group.each.setup(() => setupTestConfig())

  test('create() adds a tenant and returns it', async ({ assert }) => {
    const repo = mockTenantRepository()
    const tenant = await repo.create({
      name: 'Acme',
      email: 'a@b.c',
      status: 'provisioning',
    })
    assert.equal(tenant.name, 'Acme')
    assert.equal(tenant.status, 'provisioning')
    assert.equal(repo.count(), 1)
    assert.strictEqual(await repo.findById(tenant.id), tenant)
  })

  test('add() inserts an external tenant and overwrites by id', async ({ assert }) => {
    const repo = mockTenantRepository()
    const t1 = buildTestTenant({ id: '22222222-2222-4222-8222-222222222222', name: 'first' })
    const t2 = buildTestTenant({ id: '22222222-2222-4222-8222-222222222222', name: 'second' })

    repo.add(t1)
    assert.equal(repo.count(), 1)
    repo.add(t2)
    assert.equal(repo.count(), 1)
    assert.strictEqual(await repo.findById(t1.id), t2)
  })

  test('clear() empties the repo', ({ assert }) => {
    const repo = mockTenantRepository([buildTestTenant(), buildTestTenant()])
    assert.equal(repo.count(), 2)
    repo.clear()
    assert.equal(repo.count(), 0)
  })
})

test.group('MockTenantRepository — each() cursor', (group) => {
  group.each.setup(() => setupTestConfig())

  test('each() visits every non-deleted tenant exactly once', async ({ assert }) => {
    const repo = mockTenantRepository(
      Array.from({ length: 5 }, () => buildTestTenant({ status: 'active' }))
    )
    const visited: string[] = []
    await repo.each((t) => {
      visited.push(t.id)
    })
    assert.lengthOf(visited, 5)
    assert.equal(new Set(visited).size, 5)
  })

  test('each() awaits async callbacks sequentially', async ({ assert }) => {
    const repo = mockTenantRepository([
      buildTestTenant(),
      buildTestTenant(),
      buildTestTenant(),
    ])
    const order: number[] = []
    let i = 0
    await repo.each(async () => {
      const me = ++i
      await new Promise((r) => setTimeout(r, 5))
      order.push(me)
    })
    assert.deepEqual(order, [1, 2, 3])
  })

  test('each() skips soft-deleted by default', async ({ assert }) => {
    const { DateTime } = await import('luxon')
    const alive = buildTestTenant()
    const dead = buildTestTenant({ deletedAt: DateTime.now() })
    const repo = mockTenantRepository([alive, dead])

    const visited: string[] = []
    await repo.each((t) => {
      visited.push(t.id)
    })
    assert.deepEqual(visited, [alive.id])
  })

  test('each({ includeDeleted: true }) visits soft-deleted', async ({ assert }) => {
    const { DateTime } = await import('luxon')
    const alive = buildTestTenant()
    const dead = buildTestTenant({ deletedAt: DateTime.now() })
    const repo = mockTenantRepository([alive, dead])

    const visited: string[] = []
    await repo.each(
      (t) => {
        visited.push(t.id)
      },
      { includeDeleted: true }
    )
    assert.deepEqual(visited.sort(), [alive.id, dead.id].sort())
  })

  test('each({ statuses }) filters by status', async ({ assert }) => {
    const active = buildTestTenant({ status: 'active' })
    const suspended = buildTestTenant({ status: 'suspended' })
    const repo = mockTenantRepository([active, suspended])

    const visited: string[] = []
    await repo.each(
      (t) => {
        visited.push(t.id)
      },
      { statuses: ['suspended'] }
    )
    assert.deepEqual(visited, [suspended.id])
  })

  test('each() aborts iteration when callback throws', async ({ assert }) => {
    const t1 = buildTestTenant()
    const t2 = buildTestTenant()
    const t3 = buildTestTenant()
    const repo = mockTenantRepository([t1, t2, t3])

    const visited: string[] = []
    await assert.rejects(() =>
      repo.each((t) => {
        visited.push(t.id)
        if (visited.length === 2) throw new Error('stop')
      })
    )
    assert.lengthOf(visited, 2)
  })
})
