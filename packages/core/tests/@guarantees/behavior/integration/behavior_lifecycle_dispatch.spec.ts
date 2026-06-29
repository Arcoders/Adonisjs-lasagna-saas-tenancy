import { test } from '@japa/runner'
import emitter from '@adonisjs/core/services/emitter'
import {
  TenantCreated,
  TenantActivated,
  TenantSuspended,
  TenantProvisioned,
  TenantDeleted,
  TenantUpdated,
  TenantMigrated,
  TenantBackedUp,
  TenantRestored,
  TenantCloned,
  TenantQuotaExceeded,
  TenantEnteredMaintenance,
  TenantExitedMaintenance,
} from '@adonisjs-lasagna/saas-tenancy/events'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { BackupMetadata, CloneResult } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Lifecycle event dispatch coverage.
 *
 * The 13 typed events are emitted across commands, jobs, services and
 * the admin controller — too many call sites to drive end-to-end from
 * a single spec. Instead, we exercise the contract that every call
 * site relies on: each event class is constructible with its declared
 * payload, registered with the BaseEvent emitter, and observable via
 * `emitter.fake()`. If any of these assertions break, every dispatch
 * site silently breaks too.
 */
test.group('lifecycle events — dispatch and payload contract', (group) => {
  let tenant: TenantModelContract
  let secondTenant: TenantModelContract

  group.setup(async () => {
    const a = await createTestTenant({ name: 'Event Test Tenant' })
    const b = await createTestTenant({ name: 'Event Test Destination' })
    const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
    tenant = (await Tenant.findOrFail(a.id)) as unknown as TenantModelContract
    secondTenant = (await Tenant.findOrFail(b.id)) as unknown as TenantModelContract
  })

  group.teardown(async () => {
    await destroyTestTenant(tenant.id).catch(() => {})
    await destroyTestTenant(secondTenant.id).catch(() => {})
  })

  group.each.teardown(() => emitter.restore())

  test('TenantCreated dispatches with the tenant payload', async ({ assert }) => {
    const buf = emitter.fake([TenantCreated])
    await TenantCreated.dispatch(tenant)
    buf.assertEmitted(TenantCreated)
    const found = buf.find(TenantCreated) as any
    assert.equal(found.data.tenant.id, tenant.id)
  })

  test('TenantProvisioned dispatches with the tenant payload', async ({ assert }) => {
    const buf = emitter.fake([TenantProvisioned])
    await TenantProvisioned.dispatch(tenant)
    buf.assertEmitted(TenantProvisioned)
    const found = buf.find(TenantProvisioned) as any
    assert.equal(found.data.tenant.id, tenant.id)
  })

  test('TenantActivated dispatches with the tenant payload', async ({ assert }) => {
    const buf = emitter.fake([TenantActivated])
    await TenantActivated.dispatch(tenant)
    buf.assertEmitted(TenantActivated)
    const found = buf.find(TenantActivated) as any
    assert.equal(found.data.tenant.id, tenant.id)
  })

  test('TenantSuspended dispatches with the tenant payload', async ({ assert }) => {
    const buf = emitter.fake([TenantSuspended])
    await TenantSuspended.dispatch(tenant)
    buf.assertEmitted(TenantSuspended)
    const found = buf.find(TenantSuspended) as any
    assert.equal(found.data.tenant.id, tenant.id)
  })

  test('TenantUpdated dispatches with the tenant + diff payload', async ({ assert }) => {
    const buf = emitter.fake([TenantUpdated])
    const changes = { name: { from: 'old', to: 'new' } }
    await TenantUpdated.dispatch(tenant, changes)
    buf.assertEmitted(TenantUpdated)
    const found = buf.find(TenantUpdated) as any
    assert.equal(found.data.tenant.id, tenant.id)
    assert.deepEqual(found.data.changes, changes)
  })

  test('TenantMigrated dispatches with the tenant + direction payload', async ({ assert }) => {
    const buf = emitter.fake([TenantMigrated])
    await TenantMigrated.dispatch(tenant, 'up')
    await TenantMigrated.dispatch(tenant, 'down')
    buf.assertEmittedCount(TenantMigrated, 2)
    const events = buf.all().filter((e) => e.event === TenantMigrated)
    const directions = events.map((e: any) => e.data.direction).sort()
    assert.deepEqual(directions, ['down', 'up'])
  })

  test('TenantBackedUp dispatches with the tenant + backup metadata payload', async ({
    assert,
  }) => {
    const buf = emitter.fake([TenantBackedUp])
    const metadata: BackupMetadata = {
      file: 'tenant_xyz_2026-05-07T00-00-00-000Z.dump',
      size: 4096,
      timestamp: '2026-05-07T00:00:00.000Z',
      tenantId: tenant.id,
      schema: tenant.schemaName,
    }
    await TenantBackedUp.dispatch(tenant, metadata)
    buf.assertEmitted(TenantBackedUp)
    const found = buf.find(TenantBackedUp) as any
    assert.equal(found.data.tenant.id, tenant.id)
    assert.equal(found.data.metadata.file, metadata.file)
    assert.equal(found.data.metadata.size, 4096)
  })

  test('TenantRestored dispatches with the tenant + file name payload', async ({ assert }) => {
    const buf = emitter.fake([TenantRestored])
    await TenantRestored.dispatch(tenant, 'tenant_xyz.dump')
    buf.assertEmitted(TenantRestored)
    const found = buf.find(TenantRestored) as any
    assert.equal(found.data.tenant.id, tenant.id)
    assert.equal(found.data.fileName, 'tenant_xyz.dump')
  })

  test('TenantCloned dispatches with source/destination/result payload', async ({ assert }) => {
    const buf = emitter.fake([TenantCloned])
    const result: CloneResult = {
      source: tenant,
      destination: secondTenant,
      tablesCopied: 3,
      rowsCopied: 42,
    }
    await TenantCloned.dispatch(tenant, secondTenant, result)
    buf.assertEmitted(TenantCloned)
    const found = buf.find(TenantCloned) as any
    assert.equal(found.data.source.id, tenant.id)
    assert.equal(found.data.destination.id, secondTenant.id)
    assert.equal(found.data.result.tablesCopied, 3)
    assert.equal(found.data.result.rowsCopied, 42)
  })

  test('TenantDeleted dispatches with the tenant payload', async ({ assert }) => {
    const buf = emitter.fake([TenantDeleted])
    await TenantDeleted.dispatch(tenant)
    buf.assertEmitted(TenantDeleted)
    const found = buf.find(TenantDeleted) as any
    assert.equal(found.data.tenant.id, tenant.id)
  })

  test('TenantQuotaExceeded dispatches with quota name + limit + current + attempted', async ({
    assert,
  }) => {
    const buf = emitter.fake([TenantQuotaExceeded])
    await TenantQuotaExceeded.dispatch(tenant, 'apiCalls', 1000, 999, 5)
    buf.assertEmitted(TenantQuotaExceeded)
    const found = buf.find(TenantQuotaExceeded) as any
    assert.equal(found.data.tenant.id, tenant.id)
    assert.equal(found.data.quota, 'apiCalls')
    assert.equal(found.data.limit, 1000)
    assert.equal(found.data.current, 999)
    assert.equal(found.data.attempted, 5)
  })

  test('TenantEnteredMaintenance dispatches with the tenant + optional message payload', async ({
    assert,
  }) => {
    const buf = emitter.fake([TenantEnteredMaintenance])
    await TenantEnteredMaintenance.dispatch(tenant, 'Migrating database')
    await TenantEnteredMaintenance.dispatch(tenant, null)
    buf.assertEmittedCount(TenantEnteredMaintenance, 2)
    const events = buf.all().filter((e) => e.event === TenantEnteredMaintenance)
    const messages = events.map((e: any) => e.data.message)
    assert.includeMembers(messages, ['Migrating database', null])
  })

  test('TenantExitedMaintenance dispatches with the tenant payload', async ({ assert }) => {
    const buf = emitter.fake([TenantExitedMaintenance])
    await TenantExitedMaintenance.dispatch(tenant)
    buf.assertEmitted(TenantExitedMaintenance)
    const found = buf.find(TenantExitedMaintenance) as any
    assert.equal(found.data.tenant.id, tenant.id)
  })

  test('emitter.fake() isolates concurrent dispatches between tests', async ({ assert }) => {
    const buf = emitter.fake([TenantCreated, TenantSuspended])
    await TenantCreated.dispatch(tenant)
    buf.assertEmitted(TenantCreated)
    buf.assertNotEmitted(TenantSuspended)
    assert.equal(buf.size(), 1)
  })
})
