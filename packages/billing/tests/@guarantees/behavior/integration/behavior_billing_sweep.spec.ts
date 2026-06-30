import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import emitter from '@adonisjs/core/services/emitter'
import { runBillingSweep } from '@adonisjs-lasagna/billing'
import { BillingCustomer, BillingSubscription, TrialEnding } from '@adonisjs-lasagna/billing'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from '../../../helpers/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'

/**
 * `tenant:billing:sweep` / `runBillingSweep` drives the two time-based,
 * provider-agnostic chores that don't ride a webhook:
 *   1. Trial-ending notices — the Paddle / Lemon Squeezy fallback for Stripe's
 *      native `trial_will_end`, deduped against `trial_ending_notified_at`.
 *   2. Grace-period dunning downgrades scheduled via `dunning_downgrade_at`.
 */
test.group('Billing sweep (integration)', (group) => {
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
  })

  async function seedSub(over: {
    status?: string
    trialEnd?: DateTime | null
    trialEndingNotifiedAt?: DateTime | null
    dunningDowngradeAt?: DateTime | null
    planName?: string
  }): Promise<{ tenantId: string; subId: string }> {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    await cus.save()

    const sub = new BillingSubscription()
    sub.providerSubscriptionId = `sub_${randomUUID().slice(0, 8)}`
    sub.tenantId = tenant.id
    sub.status = (over.status ?? 'trialing') as never
    sub.currentPeriodStart = DateTime.utc().minus({ days: 1 })
    sub.currentPeriodEnd = DateTime.utc().plus({ days: 29 })
    sub.cancelAtPeriodEnd = false
    sub.cancelAt = null
    sub.canceledAt = null
    sub.trialEnd = over.trialEnd ?? null
    sub.trialEndingNotifiedAt = over.trialEndingNotifiedAt ?? null
    sub.dunningDowngradeAt = over.dunningDowngradeAt ?? null
    sub.planName = over.planName ?? 'pro'
    sub.lastEventAt = DateTime.utc().minus({ minutes: 1 })
    sub.raw = {}
    await sub.save()
    return { tenantId: tenant.id, subId: sub.providerSubscriptionId }
  }

  test('emits TrialEnding once for a trial ending within the lead window and stamps the flag', async ({
    assert,
  }) => {
    const seed = await seedSub({ status: 'trialing', trialEnd: DateTime.utc().plus({ days: 2 }) })
    const captured: Array<{ subscriptionId: string; daysLeft: number }> = []
    const off = emitter.on(TrialEnding, async (e) => {
      captured.push({ subscriptionId: e.payload.subscriptionId, daysLeft: e.payload.daysLeft })
    })

    try {
      const first = await runBillingSweep()
      assert.equal(first.trialNotices, 1)
      assert.lengthOf(captured, 1)
      assert.equal(captured[0].subscriptionId, seed.subId)
      assert.isAtLeast(captured[0].daysLeft, 1)

      const sub = await BillingSubscription.find(seed.subId)
      assert.isNotNull(sub?.trialEndingNotifiedAt, 'flag stamped')

      // Re-running must not re-notify.
      const second = await runBillingSweep()
      assert.equal(second.trialNotices, 0)
      assert.lengthOf(captured, 1, 'no duplicate notice on the second sweep')
    } finally {
      off()
    }
  })

  test('does NOT notify a trial ending beyond the lead window', async ({ assert }) => {
    await seedSub({ status: 'trialing', trialEnd: DateTime.utc().plus({ days: 30 }) })
    let count = 0
    const off = emitter.on(TrialEnding, async () => {
      count += 1
    })
    try {
      const res = await runBillingSweep()
      assert.equal(res.trialNotices, 0)
      assert.equal(count, 0)
    } finally {
      off()
    }
  })

  test('a sub already notified (native trial_will_end stamped) is not re-notified by the sweep', async ({
    assert,
  }) => {
    await seedSub({
      status: 'trialing',
      trialEnd: DateTime.utc().plus({ days: 2 }),
      trialEndingNotifiedAt: DateTime.utc().minus({ hours: 1 }),
    })
    let count = 0
    const off = emitter.on(TrialEnding, async () => {
      count += 1
    })
    try {
      const res = await runBillingSweep()
      assert.equal(res.trialNotices, 0)
      assert.equal(count, 0, 'native-stamped sub skipped')
    } finally {
      off()
    }
  })

  test('applies a due grace-period downgrade and clears the timestamp', async ({ assert }) => {
    const seed = await seedSub({
      status: 'past_due',
      dunningDowngradeAt: DateTime.utc().minus({ minutes: 1 }),
      planName: 'pro',
    })
    const quotas = await app.container.make(QuotaService)
    await quotas.assignPlan(seed.tenantId, 'pro', { source: 'stripe' })

    const res = await runBillingSweep()
    assert.equal(res.downgrades, 1)

    const plan = await TenantPlan.find(seed.tenantId)
    assert.equal(plan?.planName, 'starter', 'downgraded to defaultPlan')

    const sub = await BillingSubscription.find(seed.subId)
    assert.isNull(sub?.dunningDowngradeAt, 'schedule cleared')
  })

  test('does NOT apply a grace downgrade that is not yet due', async ({ assert }) => {
    const seed = await seedSub({
      status: 'past_due',
      dunningDowngradeAt: DateTime.utc().plus({ days: 7 }),
      planName: 'pro',
    })
    const quotas = await app.container.make(QuotaService)
    await quotas.assignPlan(seed.tenantId, 'pro', { source: 'stripe' })

    const res = await runBillingSweep()
    assert.equal(res.downgrades, 0)

    const plan = await TenantPlan.find(seed.tenantId)
    assert.equal(plan?.planName, 'pro', 'still on pro until the window elapses')
    const sub = await BillingSubscription.find(seed.subId)
    assert.isNotNull(sub?.dunningDowngradeAt)
  })
})
