import { test } from '@japa/runner'
import { FeatureFlagService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantFeatureFlag } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

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
    assert.equal(list[0].flag, 'beta_dashboard')
    assert.deepEqual(list[0].config, { rollout: 25 })
  })

  test('set() called twice for the same flag updates the row', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    await svc.set(t.id, 'experimental', true)
    await svc.set(t.id, 'experimental', false, { reason: 'rolled-back' })

    const list = await svc.listForTenant(t.id)
    assert.lengthOf(list, 1, 'second call should update, not insert')
    assert.isFalse(list[0].enabled)
    assert.deepEqual(list[0].config, { reason: 'rolled-back' })
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
})
