import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { FeatureFlagService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantFeatureFlag } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'

test.group('FeatureFlagService (integration)', (group) => {
  const svc = new FeatureFlagService()
  const cleanup: string[] = []

  group.each.teardown(async () => {
    while (cleanup.length) {
      const id = cleanup.pop()!
      await TenantFeatureFlag.query().where('tenant_id', id).delete()
      await destroyTestTenant(id)
    }
  })

  test('set() upserts a flag and listForTenant() reads it back', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    const row = await svc.set(t.id, 'beta_dashboard', true, { rollout: 25 })
    assert.equal(row.flag, 'beta_dashboard')
    assert.isTrue(row.enabled)

    const list = await svc.listForTenant(t.id)
    assert.lengthOf(list, 1)
    assert.equal(list[0]!.flag, 'beta_dashboard')
    assert.deepEqual(list[0]!.config, { rollout: 25 })
  })

  test('set() called twice for the same flag updates the row', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    await svc.set(t.id, 'experimental', true)
    await svc.set(t.id, 'experimental', false, { reason: 'rolled-back' })

    const list = await svc.listForTenant(t.id)
    assert.lengthOf(list, 1, 'second call should update, not insert')
    assert.isFalse(list[0]!.enabled)
    assert.deepEqual(list[0]!.config, { reason: 'rolled-back' })
  })

  test('isEnabled() reflects the persisted value', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    assert.isFalse(await svc.isEnabled(t.id, 'unknown'))

    await svc.set(t.id, 'feature_a', true)
    await svc.set(t.id, 'feature_b', false)

    assert.isTrue(await svc.isEnabled(t.id, 'feature_a'))
    assert.isFalse(await svc.isEnabled(t.id, 'feature_b'))
  })

  test('flags are isolated between tenants', async ({ assert }) => {
    const a = await createTestTenant()
    const b = await createTestTenant()
    cleanup.push(a.id, b.id)

    await svc.set(a.id, 'shared_name', true)

    assert.isTrue(await svc.isEnabled(a.id, 'shared_name'))
    assert.isFalse(await svc.isEnabled(b.id, 'shared_name'))

    const listA = await svc.listForTenant(a.id)
    const listB = await svc.listForTenant(b.id)
    assert.lengthOf(listA, 1)
    assert.lengthOf(listB, 0)
  })

  test('delete() removes the row and clears the cached lookup', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    await svc.set(t.id, 'temp', true)
    assert.isTrue(await svc.isEnabled(t.id, 'temp'))

    await svc.delete(t.id, 'temp')
    assert.isFalse(await svc.isEnabled(t.id, 'temp'))

    const list = await svc.listForTenant(t.id)
    assert.lengthOf(list, 0)
  })

  test('getFlag() returns the raw record, or null when unset', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    assert.isNull(await svc.getFlag(t.id, 'absent'))

    await svc.set(t.id, 'beta', true, { rollout: 25 })
    const f = await svc.getFlag(t.id, 'beta')
    assert.isNotNull(f)
    assert.isTrue(f!.enabled)
    assert.deepEqual(f!.config, { rollout: 25 })
    assert.isNull(f!.expiresAt)
  })

  test('set() with expiresAt round-trips and is exposed on getFlag()', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    const future = DateTime.utc().plus({ days: 1 })
    await svc.set(t.id, 'campaign', true, undefined, future)

    const f = await svc.getFlag(t.id, 'campaign')
    assert.isNotNull(f)
    assert.isNotNull(f!.expiresAt)
    assert.equal(DateTime.fromISO(f!.expiresAt!).toMillis(), future.toMillis())
  })

  test('an expired flag reads enabled in getFlag() but disabled in isEnabled()', async ({
    assert,
  }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    // Enabled, but the expiry is already in the past.
    await svc.set(t.id, 'holiday', true, undefined, DateTime.utc().minus({ minutes: 1 }))

    const f = await svc.getFlag(t.id, 'holiday')
    assert.isTrue(f!.enabled, 'getFlag is a faithful data accessor — it does not apply expiry')
    assert.isFalse(await svc.isEnabled(t.id, 'holiday'), 'isEnabled honours expiry')
  })

  test('a future expiry leaves the flag enabled', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    await svc.set(t.id, 'launch', true, undefined, DateTime.utc().plus({ hours: 1 }))
    assert.isTrue(await svc.isEnabled(t.id, 'launch'))
  })
})
