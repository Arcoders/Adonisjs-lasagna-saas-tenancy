import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe } from '@adonisjs-lasagna/billing'
import { BillingCustomer, BillingSubscription } from '@adonisjs-lasagna/billing'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import {
  setupBillingConfig,
  buildNeutralSubscription,
  clearBillingTables,
} from '../../../integration/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'

/**
 * A5: a user upgrade followed by a LATE, stale webhook for the prior plan must
 * not roll the tenant back. `event_ordering.spec.ts` proves the guard at the
 * `status` field; this proves it end-to-end at the plan/quota level — the thing
 * a customer actually feels.
 *
 * Scenario: tenant upgrades pro → team (newer `subscription.upsert`, t=now).
 * A stale `subscription.upsert` for the OLD period (t=now-30s, prod_pro) is
 * re-delivered out of order. The `last_event_at - 5s` ordering guard must drop
 * it, leaving both the mirror and `tenant_plans` on `team`.
 *
 * It passes today (the guard holds), so no optimistic-locking `version` column
 * is introduced — per the plan, that only lands if a race test actually fails.
 */
test.group('Upgrade vs. stale webhook race (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()
  })

  group.each.teardown(async () => {
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  test('a stale prod_pro event does not revert a fresh upgrade to team', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const providerCustomerId = `cus_test_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const subId = `sub_upgrade_${randomUUID().slice(0, 8)}`
    const tNow = Math.floor(Date.now() / 1000)

    // Upgrade: newest event wins, tenant lands on `team`.
    const upgraded = await billing.syncSubscription(
      buildNeutralSubscription({
        id: subId,
        customer: providerCustomerId,
        productId: 'prod_team',
        status: 'active',
      }),
      tNow
    )
    assert.equal(upgraded?.plan, 'team')
    assert.equal((await TenantPlan.find(tenant.id))?.planName, 'team')

    // Stale redelivery for the prior plan (prod_pro), 30s older. Dropped.
    const stale = await billing.syncSubscription(
      buildNeutralSubscription({
        id: subId,
        customer: providerCustomerId,
        productId: 'prod_pro',
        status: 'active',
      }),
      tNow - 30
    )
    assert.isNull(stale, 'stale event is a no-op')

    // The upgrade survives, in both the mirror and the quota assignment.
    const row = await BillingSubscription.find(subId)
    assert.equal(row?.planName, 'team', 'mirror still on team')
    assert.equal((await TenantPlan.find(tenant.id))?.planName, 'team', 'quota still on team')
  })
})
