import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe } from '@adonisjs-lasagna/billing'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { BillingCustomer, BillingSubscription } from '@adonisjs-lasagna/billing'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import {
  setupBillingConfig,
  buildNeutralSubscription,
  clearBillingTables,
} from '../../../integration/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'

/**
 * BillingService.syncSubscription is the keystone routine — every
 * webhook event lands here. We test:
 *   - creation flow → tenant_plans gets the mapped plan, sub row written
 *   - status change (active → canceled) downgrades to defaultPlan
 *   - unmapped product falls back to defaultPlan (never throws)
 */
test.group('BillingService.syncSubscription (integration)', (group) => {
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

  async function seedCustomer(): Promise<{ tenantId: string; providerCustomerId: string }> {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const providerCustomerId = `cus_test_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()
    return { tenantId: tenant.id, providerCustomerId }
  }

  test('subscription.created upserts the row and assigns the mapped plan', async ({ assert }) => {
    const { tenantId, providerCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const sub = buildNeutralSubscription({
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'active',
    })
    const result = await billing.syncSubscription(sub, Math.floor(Date.now() / 1000))

    assert.isNotNull(result)
    assert.equal(result?.plan, 'pro')
    assert.equal(result?.tenant_id, tenantId)

    const row = await BillingSubscription.find(sub.providerSubscriptionId)
    assert.isNotNull(row)
    assert.equal(row?.tenantId, tenantId)
    assert.equal(row?.status, 'active')
    assert.equal(row?.planName, 'pro')

    const tenantPlan = await TenantPlan.find(tenantId)
    assert.isNotNull(tenantPlan)
    assert.equal(tenantPlan?.planName, 'pro')
    assert.equal(tenantPlan?.source, 'stripe')
  })

  test('an unrecognized provider status does not overwrite a known status (fail-safe)', async ({
    assert,
  }) => {
    const { providerCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))
    const now = Math.floor(Date.now() / 1000)

    // 1. Establish a known active subscription.
    const active = buildNeutralSubscription({
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'active',
      id: 'sub_unknown_status',
    })
    await billing.syncSubscription(active, now)
    let row = await BillingSubscription.find('sub_unknown_status')
    assert.equal(row?.status, 'active')

    // 2. A later event carries a status the driver couldn't map: the mapper
    //    fails closed to `incomplete` and flags `statusRecognized: false`. The
    //    mirror must KEEP the known `active`, never trust the guess.
    const unknown = buildNeutralSubscription({
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'incomplete',
      id: 'sub_unknown_status',
    })
    ;(unknown as { statusRecognized?: boolean }).statusRecognized = false
    const result = await billing.syncSubscription(unknown, now + 10)

    assert.isNotNull(result)
    row = await BillingSubscription.find('sub_unknown_status')
    assert.equal(row?.status, 'active', 'unknown status did not overwrite the known active status')
  })

  test('subscription.deleted downgrades the tenant to defaultPlan', async ({ assert }) => {
    const { tenantId, providerCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    // First activate.
    const sub = buildNeutralSubscription({
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'active',
      id: 'sub_to_be_canceled',
    })
    await billing.syncSubscription(sub, Math.floor(Date.now() / 1000))
    let tenantPlan = await TenantPlan.find(tenantId)
    assert.equal(tenantPlan?.planName, 'pro')

    // Now cancel — pass `downgrade: true` (matches the dispatcher's
    // handling for `customer.subscription.deleted`).
    const canceledSub = buildNeutralSubscription({
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'canceled',
      id: 'sub_to_be_canceled',
      canceledAt: Math.floor(Date.now() / 1000),
    })
    await billing.syncSubscription(canceledSub, Math.floor(Date.now() / 1000) + 100, {
      downgrade: true,
    })

    tenantPlan = await TenantPlan.find(tenantId)
    assert.equal(tenantPlan?.planName, 'starter', 'downgrade lands on defaultPlan')

    const row = await BillingSubscription.find('sub_to_be_canceled')
    assert.equal(row?.status, 'canceled')
  })

  test('unmapped Stripe product falls back to defaultPlan', async ({ assert }) => {
    const { tenantId, providerCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const sub = buildNeutralSubscription({
      customer: providerCustomerId,
      productId: 'prod_unknown_xxx',
      status: 'active',
    })
    const result = await billing.syncSubscription(sub, Math.floor(Date.now() / 1000))

    assert.equal(result?.plan, 'starter', 'falls back to defaultPlan')
    const tenantPlan = await TenantPlan.find(tenantId)
    assert.equal(tenantPlan?.planName, 'starter')
  })

  test('throws BillingException when the customer mapping is missing', async ({ assert }) => {
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const sub = buildNeutralSubscription({
      customer: 'cus_unknown_no_mapping',
      productId: 'prod_pro',
    })
    await assert.rejects(
      () => billing.syncSubscription(sub, Math.floor(Date.now() / 1000)),
      /no local billing_customers row/
    )
  })

  test('assignPlan failure leaves the mirror untouched (transactional ordering)', async ({
    assert,
  }) => {
    // Regression: previously syncSubscription wrote the mirror first and
    // assigned the plan after. A throw from assignPlan (e.g., a plan
    // name removed from config.plans.definitions while subscriptions
    // referencing it still exist in Stripe) would leave the local
    // mirror reflecting the new plan but the QuotaService still on
    // the old one — tenant billed at upgrade rate but limited at
    // downgrade rate. The fix flipped the order so a failing
    // assignPlan() short-circuits before row.save().
    const { providerCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    // Simulate config drift: 'pro' is mapped from prod_pro but no
    // longer exists in plans.definitions.
    const baseCfg = getConfig()
    setConfig({
      ...baseCfg,
      plans: {
        ...baseCfg.plans!,
        definitions: {
          starter: baseCfg.plans!.definitions.starter,
          // pro deliberately removed
          team: baseCfg.plans!.definitions.team,
        },
      },
    } as never)

    const subId = `sub_drift_${randomUUID().slice(0, 8)}`
    const sub = buildNeutralSubscription({
      id: subId,
      customer: providerCustomerId,
      productId: 'prod_pro', // maps to 'pro' which is now undefined
      status: 'active',
    })

    await assert.rejects(
      () => billing.syncSubscription(sub, Math.floor(Date.now() / 1000)),
      /plan "pro" is not declared/
    )

    // The mirror MUST NOT exist — row.save() runs after assignPlan.
    const mirror = await BillingSubscription.find(subId)
    assert.isNull(mirror, 'mirror must not be written when assignPlan fails')
  })

  test('upgrade mid-cycle: subscription.updated swaps product → plan changes (T-3)', async ({
    assert,
  }) => {
    // T-3 from the audit. Tenant is on 'pro'; Stripe sends a
    // subscription.updated with a new product mapped to 'team'. The
    // mirror, the TenantPlan, and QuotaService should all converge on
    // 'team' after a single event.
    const { tenantId, providerCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))
    const quotas = await app.container.make(QuotaService)
    const fakeTenant = { id: tenantId } as never

    // Create the initial 'pro' subscription.
    const subId = `sub_upgrade_${randomUUID().slice(0, 8)}`
    const proSub = buildNeutralSubscription({
      id: subId,
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'active',
    })
    await billing.syncSubscription(proSub, Math.floor(Date.now() / 1000))
    assert.equal(await quotas.getLimit(fakeTenant, 'apiRequests'), 10_000)
    let mirror = await BillingSubscription.find(subId)
    assert.equal(mirror?.planName, 'pro')

    // Stripe fires subscription.updated with the new product.
    const teamSub = buildNeutralSubscription({
      id: subId,
      customer: providerCustomerId,
      productId: 'prod_team',
      status: 'active',
    })
    const result = await billing.syncSubscription(teamSub, Math.floor(Date.now() / 1000) + 5)
    assert.equal(result?.previousPlan, 'pro', 'previousPlan reflects the prior assignment')
    assert.equal(result?.plan, 'team')

    // Mirror, tenant_plans, and quota all converge on 'team'.
    mirror = await BillingSubscription.find(subId)
    assert.equal(mirror?.planName, 'team')
    const tp = await TenantPlan.find(tenantId)
    assert.equal(tp?.planName, 'team')
    assert.equal(await quotas.getLimit(fakeTenant, 'apiRequests'), 50_000)
  })

  test('pause/resume lifecycle: status flips between paused and active (T-10)', async ({
    assert,
  }) => {
    const { tenantId, providerCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const subId = `sub_pause_${randomUUID().slice(0, 8)}`
    const active = buildNeutralSubscription({
      id: subId,
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'active',
    })
    await billing.syncSubscription(active, Math.floor(Date.now() / 1000))
    let mirror = await BillingSubscription.find(subId)
    assert.equal(mirror?.status, 'active')

    // Pause.
    const paused = buildNeutralSubscription({
      id: subId,
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'paused',
    })
    await billing.syncSubscription(paused, Math.floor(Date.now() / 1000) + 5)
    mirror = await BillingSubscription.find(subId)
    assert.equal(mirror?.status, 'paused')

    // The plan stays — the host's middleware can refuse requests on
    // status != 'active' if it wants to enforce a hard pause.
    assert.equal(mirror?.planName, 'pro')
    const tpDuringPause = await TenantPlan.find(tenantId)
    assert.equal(tpDuringPause?.planName, 'pro')

    // Resume.
    const resumed = buildNeutralSubscription({
      id: subId,
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'active',
    })
    await billing.syncSubscription(resumed, Math.floor(Date.now() / 1000) + 10)
    mirror = await BillingSubscription.find(subId)
    assert.equal(mirror?.status, 'active', 'resumed flips back to active')
  })

  test('cancel_at_period_end is mirrored without changing status; clearing it works', async ({
    assert,
  }) => {
    const { tenantId, providerCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))
    const subId = `sub_cape_${randomUUID().slice(0, 8)}`

    // Tenant schedules a cancellation. The subscription is STILL active
    // until the period actually ends — only the flag flips.
    await billing.syncSubscription(
      buildNeutralSubscription({
        id: subId,
        customer: providerCustomerId,
        productId: 'prod_pro',
        status: 'active',
        cancelAtPeriodEnd: true,
        canceledAt: Math.floor(Date.now() / 1000),
      }),
      Math.floor(Date.now() / 1000)
    )
    let mirror = await BillingSubscription.find(subId)
    assert.equal(mirror?.cancelAtPeriodEnd, true, 'flag mirrored')
    assert.equal(
      mirror?.status,
      'active',
      'still active — cancellation is scheduled, not immediate'
    )
    assert.equal(mirror?.planName, 'pro', 'plan unchanged while the scheduled cancel is pending')
    assert.isNotNull(mirror?.canceledAt)
    assert.equal((await TenantPlan.find(tenantId))?.planName, 'pro')

    // Tenant changes their mind — the flag is cleared on the next update.
    await billing.syncSubscription(
      buildNeutralSubscription({
        id: subId,
        customer: providerCustomerId,
        productId: 'prod_pro',
        status: 'active',
        cancelAtPeriodEnd: false,
      }),
      Math.floor(Date.now() / 1000) + 5
    )
    mirror = await BillingSubscription.find(subId)
    assert.equal(mirror?.cancelAtPeriodEnd, false, 'flag cleared')
    assert.isNull(mirror?.canceledAt, 'canceled_at cleared along with it')
  })

  test('scheduled cancellation completes: subscription.deleted → canceled + downgrade', async ({
    assert,
  }) => {
    const { tenantId, providerCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))
    const subId = `sub_cape_done_${randomUUID().slice(0, 8)}`

    // Active with a scheduled cancellation.
    await billing.syncSubscription(
      buildNeutralSubscription({
        id: subId,
        customer: providerCustomerId,
        productId: 'prod_pro',
        status: 'active',
        cancelAtPeriodEnd: true,
      }),
      Math.floor(Date.now() / 1000)
    )
    assert.equal((await TenantPlan.find(tenantId))?.planName, 'pro')

    // Period ends → Stripe fires customer.subscription.deleted. Routed
    // through syncSubscription with downgrade:true (the dispatcher's
    // handling for deletions), so it lands on defaultPlan.
    await billing.syncSubscription(
      buildNeutralSubscription({
        id: subId,
        customer: providerCustomerId,
        productId: 'prod_pro',
        status: 'canceled',
        canceledAt: Math.floor(Date.now() / 1000),
      }),
      Math.floor(Date.now() / 1000) + 10,
      { downgrade: true }
    )

    const mirror = await BillingSubscription.find(subId)
    assert.equal(mirror?.status, 'canceled')
    assert.equal(
      (await TenantPlan.find(tenantId))?.planName,
      'starter',
      'downgraded to defaultPlan'
    )
  })

  test('plan change immediately reflects via QuotaService.getLimit', async ({ assert }) => {
    const { tenantId, providerCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))
    const quotas = await app.container.make(QuotaService)

    // starter limit = 100; pro limit = 10_000.
    const fakeTenant = { id: tenantId } as never
    assert.equal(await quotas.getLimit(fakeTenant, 'apiRequests'), 100, 'starts on defaultPlan')

    const sub = buildNeutralSubscription({ customer: providerCustomerId, productId: 'prod_pro' })
    await billing.syncSubscription(sub, Math.floor(Date.now() / 1000))

    assert.equal(
      await quotas.getLimit(fakeTenant, 'apiRequests'),
      10_000,
      'pro plan visible immediately after sync'
    )
  })
})
