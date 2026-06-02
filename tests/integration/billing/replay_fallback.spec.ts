import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/billing'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { StripeCustomer, StripeSubscription, StripeProcessedEvent } from '@adonisjs-lasagna/billing'
import { ProcessStripeEventJob } from '@adonisjs-lasagna/billing'
import { BillingException } from '@adonisjs-lasagna/billing'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import {
  setupBillingConfig,
  buildSubscription,
  buildEvent,
  clearBillingTables,
  hydrateJob,
} from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

/**
 * §B1 regression — `BillingService.retrieveEvent()` falls back to the
 * controller-persisted replayable payload when Stripe can no longer return
 * the event (the `tenant:billing:replay`-of-an-aged-out-event case).
 *
 * The strong assertion: the tenant lands on the MAPPED plan (`pro`), not
 * the `starter` default. A lossy reconstruction (missing `items.price.product`)
 * would silently fall back to defaultPlan — so `pro` proves the rebuilt
 * event carried the structural fields `syncSubscription` needs.
 */
test.group('BillingService.retrieveEvent — local payload fallback (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>
  let originalDispatch: typeof ProcessStripeEventJob.dispatch
  let pendingJobs: string[] = []

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()

    // Capture dispatched job ids so we can drain them inline.
    pendingJobs = []
    originalDispatch = ProcessStripeEventJob.dispatch
    ;(ProcessStripeEventJob as unknown as {
      dispatch: (p: { eventId: string }) => Promise<void>
    }).dispatch = async (p) => {
      pendingJobs.push(p.eventId)
    }
  })

  group.each.teardown(async () => {
    ;(ProcessStripeEventJob as unknown as {
      dispatch: typeof originalDispatch
    }).dispatch = originalDispatch
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    billing.__resetForTests()
  })

  async function flushJobs(): Promise<void> {
    while (pendingJobs.length) {
      const eventId = pendingJobs.shift()!
      const job = new ProcessStripeEventJob()
      hydrateJob(job, { eventId })
      await job.execute()
    }
  }

  async function seedCustomer(): Promise<{ tenantId: string; stripeCustomerId: string }> {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const stripeCustomerId = `cus_test_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()
    return { tenantId: tenant.id, stripeCustomerId }
  }

  test('aged-out event: rebuilt from local payload → mapped plan assigned', async ({
    assert,
    client,
  }) => {
    const { tenantId, stripeCustomerId } = await seedCustomer()

    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    billing.__setStripeForTests(mock)

    const subId = `sub_replay_${randomUUID().slice(0, 8)}`
    const sub = buildSubscription({
      id: subId,
      customer: stripeCustomerId,
      productId: 'prod_pro',
      status: 'active',
    })
    const event = buildEvent('customer.subscription.updated', sub, { id: 'evt_replay_agedout' })

    // Deliberately DO NOT `mock.injectEvent(event)` → `events.retrieve` will
    // throw, simulating an event that aged out of Stripe's retrieval window.

    // 1) Real receive path: the controller persists the replayable payload.
    const body = JSON.stringify(event)
    const sig = signWebhookPayload(body, 'whsec_test_billing_helper')
    const res = await client
      .post('/webhooks/stripe')
      .header('content-type', 'application/json')
      .header('stripe-signature', sig)
      .json(event)
    res.assertStatus(200)

    const ledger = await StripeProcessedEvent.find('evt_replay_agedout')
    assert.isNotNull(ledger, 'controller wrote the ledger row + payload')
    assert.isObject(ledger?.payload, 'payload persisted')

    // 2) Process inline. The job calls retrieveEvent → Stripe throws →
    //    fallback reconstructs from the persisted payload → syncSubscription.
    await flushJobs()

    // 3) Faithful reconstruction proof: mapped plan, not the default.
    const mirror = await StripeSubscription.find(subId)
    assert.isNotNull(mirror, 'subscription mirror written from the rebuilt event')
    assert.equal(mirror?.status, 'active')
    assert.equal(mirror?.planName, 'pro')

    const tenantPlan = await TenantPlan.find(tenantId)
    assert.equal(tenantPlan?.planName, 'pro', 'tenant on mapped plan — reconstruction was faithful')

    const processed = await StripeProcessedEvent.find('evt_replay_agedout')
    assert.equal(processed?.status, 'completed')
  })

  test('retrieveEvent rejects when Stripe fails and there is no reconstructable payload', async ({
    assert,
  }) => {
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    // Ledger row exists but payload is null (legacy / hand-dispatched).
    const row = new StripeProcessedEvent()
    row.eventId = 'evt_no_payload'
    row.eventType = 'customer.subscription.updated'
    row.status = 'pending'
    row.attempts = 0
    row.payload = null
    await row.save()

    await assert.rejects(
      () => billing.retrieveEvent('evt_no_payload'),
      BillingException
    )
  })
})
