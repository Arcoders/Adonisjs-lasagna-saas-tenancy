import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import emitter from '@adonisjs/core/services/emitter'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/billing'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { BillingCustomer, BillingSubscription } from '@adonisjs-lasagna/billing'
import { TrialEnding } from '@adonisjs-lasagna/billing'
import { ProcessBillingEventJob } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import {
  setupBillingConfig,
  buildSubscription,
  buildEvent,
  clearBillingTables,
  hydrateJob,
} from './helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type Stripe from 'stripe'

/**
 * Trial lifecycle, driven end-to-end through the same chain production
 * uses:
 *
 *   POST /webhooks/stripe (signed)
 *     → VerifyBillingWebhookMiddleware (HMAC)
 *     → StripeWebhookController (ledger insert + dispatch)
 *     → ProcessBillingEventJob.execute (retrieveEvent + dispatcher)
 *
 * Calling `dispatchStripeEvent` directly would skip the middleware and
 * the job's re-fetch — both load-bearing. The job is executed inline
 * here (no BullMQ in tests) but every other layer is real.
 *
 * Scenarios (audit T-1 / T-2):
 *   - `customer.subscription.trial_will_end` → emits `TrialEnding`
 *   - trial converts to paid: `subscription.updated` flips
 *     `trialing` → `active`, plan preserved
 *   - trial expires with no usable payment method:
 *     `subscription.deleted` → mirror `canceled`, tenant downgraded
 */
test.group('Trial lifecycle (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>
  let originalDispatch: typeof ProcessBillingEventJob.dispatch
  let mock: MockStripe
  let pendingJobs: string[] = []

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()

    mock = new MockStripe('whsec_test_billing_helper')
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(mock)

    pendingJobs = []
    originalDispatch = ProcessBillingEventJob.dispatch
    ;(
      ProcessBillingEventJob as unknown as {
        dispatch: (p: { eventId: string }) => Promise<void>
      }
    ).dispatch = async (p) => {
      pendingJobs.push(p.eventId)
    }
  })

  group.each.teardown(async () => {
    ;(
      ProcessBillingEventJob as unknown as {
        dispatch: typeof originalDispatch
      }
    ).dispatch = originalDispatch
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  async function flushJobs(): Promise<void> {
    while (pendingJobs.length) {
      const eventId = pendingJobs.shift()!
      const job = new ProcessBillingEventJob()
      hydrateJob(job, { eventId })
      await job.execute()
    }
  }

  async function postSignedEvent(
    client: { post: (path: string) => any },
    event: Stripe.Event
  ): Promise<void> {
    mock.injectEvent(event)
    const body = JSON.stringify(event)
    const sig = signWebhookPayload(body, 'whsec_test_billing_helper')
    const res = await client
      .post('/webhooks/stripe')
      .header('content-type', 'application/json')
      .header('stripe-signature', sig)
      .json(event)
    res.assertStatus(200)
  }

  async function seedCustomer(): Promise<{ tenantId: string; providerCustomerId: string }> {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()
    return { tenantId: tenant.id, providerCustomerId }
  }

  test('customer.subscription.trial_will_end emits TrialEnding with daysLeft', async ({
    assert,
    client,
  }) => {
    const { tenantId, providerCustomerId } = await seedCustomer()

    // Trial ends in ~3 days — the typical lead time Stripe gives.
    const trialEndTs = Math.floor(DateTime.utc().plus({ days: 3, hours: 1 }).toSeconds())
    const sub = buildSubscription({
      id: `sub_trial_${randomUUID().slice(0, 8)}`,
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'trialing',
      trialEnd: trialEndTs,
    })
    const event = buildEvent('customer.subscription.trial_will_end', sub, {
      id: 'evt_trial_will_end',
    })

    const captured: Array<{ tenantId: string; daysLeft: number; subId: string }> = []
    const off = emitter.on(TrialEnding, async (e) => {
      captured.push({
        tenantId: e.payload.tenantId,
        daysLeft: e.payload.daysLeft,
        subId: e.payload.subscriptionId,
      })
    })

    try {
      await postSignedEvent(client, event)
      await flushJobs()

      assert.lengthOf(captured, 1, 'exactly one TrialEnding emitted')
      assert.equal(captured[0].tenantId, tenantId)
      assert.equal(captured[0].subId, sub.id)
      // ceil(3d 1h) === 4 days. Just assert it's the small positive
      // integer the host renders in "your trial ends in N days".
      assert.isAbove(captured[0].daysLeft, 0)
      assert.isAtMost(captured[0].daysLeft, 4)
    } finally {
      off()
    }
  })

  test('trial_will_end is a no-op (no throw) when the customer mapping is missing', async ({
    assert,
    client,
  }) => {
    // Stripe could fire trial_will_end for a customer we never recorded
    // locally (e.g., a subscription created outside the app). The
    // handler must swallow it, not dead-letter.
    const sub = buildSubscription({
      customer: `cus_unmapped_${randomUUID().slice(0, 8)}`,
      productId: 'prod_pro',
      status: 'trialing',
      trialEnd: Math.floor(DateTime.utc().plus({ days: 3 }).toSeconds()),
    })
    const event = buildEvent('customer.subscription.trial_will_end', sub, {
      id: 'evt_trial_unmapped',
    })

    let emitted = false
    const off = emitter.on(TrialEnding, async () => {
      emitted = true
    })

    try {
      await postSignedEvent(client, event)
      await flushJobs() // must not throw

      assert.isFalse(emitted, 'no TrialEnding for an unmapped customer')
    } finally {
      off()
    }
  })

  test('trial → paid: subscription.updated flips trialing → active, plan preserved (T-1)', async ({
    assert,
    client,
  }) => {
    const { tenantId, providerCustomerId } = await seedCustomer()
    const subId = `sub_trial_paid_${randomUUID().slice(0, 8)}`

    // 1. Subscription created in trial.
    const trialing = buildSubscription({
      id: subId,
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'trialing',
      trialEnd: Math.floor(DateTime.utc().plus({ days: 7 }).toSeconds()),
    })
    await postSignedEvent(
      client,
      buildEvent('customer.subscription.created', trialing, { id: 'evt_trial_create' })
    )
    await flushJobs()

    let mirror = await BillingSubscription.find(subId)
    assert.equal(mirror?.status, 'trialing')
    assert.equal(mirror?.planName, 'pro', 'plan assigned during trial')
    assert.isNotNull(mirror?.trialEnd)
    // QuotaService already enforces the pro plan during the trial.
    let tp = await TenantPlan.find(tenantId)
    assert.equal(tp?.planName, 'pro')

    // 2. Trial converts — Stripe fires subscription.updated with
    //    status='active' and (in practice) trial_end cleared.
    const active = buildSubscription({
      id: subId,
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'active',
      trialEnd: null,
    })
    await postSignedEvent(
      client,
      buildEvent('customer.subscription.updated', active, {
        id: 'evt_trial_convert',
        created: Math.floor(Date.now() / 1000) + 10,
      })
    )
    await flushJobs()

    mirror = await BillingSubscription.find(subId)
    assert.equal(mirror?.status, 'active', 'trial converted to active')
    assert.equal(mirror?.planName, 'pro', 'plan unchanged across the conversion')
    assert.isNull(mirror?.trialEnd, 'trialEnd cleared')
    tp = await TenantPlan.find(tenantId)
    assert.equal(tp?.planName, 'pro', 'quota assignment stable across conversion')
  })

  test('trial expires without a usable payment method: subscription.deleted downgrades (T-2)', async ({
    assert,
    client,
  }) => {
    const { tenantId, providerCustomerId } = await seedCustomer()
    const subId = `sub_trial_fail_${randomUUID().slice(0, 8)}`

    // 1. Created in trial.
    const trialing = buildSubscription({
      id: subId,
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'trialing',
      trialEnd: Math.floor(DateTime.utc().plus({ days: 1 }).toSeconds()),
    })
    await postSignedEvent(
      client,
      buildEvent('customer.subscription.created', trialing, { id: 'evt_trial2_create' })
    )
    await flushJobs()
    assert.equal((await TenantPlan.find(tenantId))?.planName, 'pro')

    // 2. Trial ends, no valid payment method → Stripe cancels the
    //    subscription and fires customer.subscription.deleted. The
    //    dispatcher routes deletions through syncSubscription with
    //    downgrade:true, so the product is NOT re-read off the dead
    //    subscription — we land on defaultPlan.
    const canceled = buildSubscription({
      id: subId,
      customer: providerCustomerId,
      productId: 'prod_pro',
      status: 'canceled',
      canceledAt: Math.floor(Date.now() / 1000),
      trialEnd: null,
    })
    await postSignedEvent(
      client,
      buildEvent('customer.subscription.deleted', canceled, {
        id: 'evt_trial2_deleted',
        created: Math.floor(Date.now() / 1000) + 10,
      })
    )
    await flushJobs()

    const mirror = await BillingSubscription.find(subId)
    assert.equal(mirror?.status, 'canceled')
    const tp = await TenantPlan.find(tenantId)
    assert.equal(tp?.planName, 'starter', 'tenant downgraded to defaultPlan')
    assert.equal(tp?.source, 'stripe')
  })
})
