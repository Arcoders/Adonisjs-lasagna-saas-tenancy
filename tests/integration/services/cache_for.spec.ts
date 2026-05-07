import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { cacheFor, getCache } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * S2-6: prove that two tenants writing the same key under cacheFor()
 * cannot read each other's value, AND that cacheFor() rejects unsafe
 * tenant ids before they touch Redis.
 */
test.group('cacheFor(tenant) — tenant-scoped cache namespace', (group) => {
  const cleanup: { tenantId: string }[] = []

  group.each.teardown(async () => {
    while (cleanup.length) {
      const { tenantId } = cleanup.pop()!
      // Reach into the underlying namespace to clear test keys without
      // depending on a public clear-all API.
      const ns = cacheFor(tenantId)
      await ns.delete({ key: 'shared-key' }).catch(() => {})
      await ns.delete({ key: 'settings' }).catch(() => {})
    }
  })

  test('two tenants writing the same key see independent values', async ({ assert }) => {
    const t1 = randomUUID()
    const t2 = randomUUID()
    cleanup.push({ tenantId: t1 }, { tenantId: t2 })

    await cacheFor(t1).set({ key: 'shared-key', value: 'tenant-1-value' })
    await cacheFor(t2).set({ key: 'shared-key', value: 'tenant-2-value' })

    const a = await cacheFor(t1).get({ key: 'shared-key' })
    const b = await cacheFor(t2).get({ key: 'shared-key' })

    assert.equal(a, 'tenant-1-value')
    assert.equal(b, 'tenant-2-value', 'tenant 2 must not see tenant 1\'s value under the same key')
  })

  test('accepts a tenant model (object with .id) as well as a raw id string', async ({ assert }) => {
    const id = randomUUID()
    cleanup.push({ tenantId: id })

    await cacheFor({ id } as any).set({ key: 'settings', value: { theme: 'dark' } })
    const fromString = await cacheFor(id).get({ key: 'settings' })

    assert.deepEqual(fromString, { theme: 'dark' })
  })

  test('rejects unsafe tenant ids before reaching Redis (key injection guard)', ({ assert }) => {
    // Anything that escapes /^[a-zA-Z0-9_-]{1,63}$/ would let a crafted
    // id forge another tenant's prefix. The assertion runs before any
    // network I/O.
    assert.throws(() => cacheFor('../etc'), /unsafe/i)
    assert.throws(() => cacheFor('id:with:colons'), /unsafe/i)
    assert.throws(() => cacheFor(''), /unsafe/i)
    assert.throws(() => cacheFor('a'.repeat(64)), /unsafe/i)
    // Newlines and Redis special chars must also be rejected.
    assert.throws(() => cacheFor('id\nINJECT'), /unsafe/i)
  })

  test('cacheFor and getCache().namespace() target the same physical store', async ({
    assert,
  }) => {
    // Document the contract: cacheFor is just sugar for a prefixed
    // namespace on the shared BentoCache instance.
    const id = randomUUID()
    cleanup.push({ tenantId: id })

    await cacheFor(id).set({ key: 'shared-key', value: 'via-cacheFor' })
    const direct = await getCache().namespace(`tenant:${id}`).get({ key: 'shared-key' })

    assert.equal(
      direct,
      'via-cacheFor',
      'cacheFor must use the same underlying namespace prefix that callers can compose by hand'
    )
  })
})
