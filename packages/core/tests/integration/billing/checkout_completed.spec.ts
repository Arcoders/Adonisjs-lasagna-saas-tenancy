import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/billing'
import {
  BillingCustomer,
  BillingProcessedEvent,
  BillingSubscription,
} from '@adonisjs-lasagna/billing'
import { ProcessBillingEventJob } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import {
  setupBillingConfig,
  buildSubscription,
  buildEvent,
  clearBillingTables,
  hydrateJob,
} from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import type Stripe from 'stripe'

/**
 * `checkout.session.completed` is the real production entry point: the
 * host 302s the tenant to a Checkout Session, Stripe completes it, and
 * this webhook arrives carrying the freshly-minted customer id. The
 * handler writes the `billing_customers` mapping so the subsequent
 * `customer.subscription.created` event can resolve the tenant.
 *
 * Driven end-to-end (POST signed → middleware → controller → job →
 * dispatcher) — the same chain `dunning_flow` / `trial_lifecycle` use.
 */
test.group('checkout.session.completed (integration)', (group) => {
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

  function buildCheckoutSession(opts: {
    tenantId: string
    customerId: string
    mode?: 'subscription' | 'payment'
  }): Stripe.Checkout.Session {
    return {
      id: `cs_${randomUUID().slice(0, 8)}`,
      object: 'checkout.session',
      mode: opts.mode ?? 'subscription',
      client_reference_id: opts.tenantId,
      customer: opts.customerId,
      status: 'complete',
      payment_status: 'paid',
      url: null,
      metadata: { tenantId: opts.tenantId },
    } as unknown as Stripe.Checkout.Session
  }

  test('checkout.session.completed creates the billing_customers mapping', async ({
    assert,
    client,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const customerId = `cus_${randomUUID().slice(0, 8)}`

    const event = buildEvent(
      'checkout.session.completed',
      buildCheckoutSession({ tenantId: tenant.id, customerId }),
      { id: 'evt_checkout_create' }
    )
    await postSignedEvent(client, event)
    await flushJobs()

    const mapping = await BillingCustomer.find(tenant.id)
    assert.isNotNull(mapping, 'billing_customers row created for the tenant')
    assert.equal(mapping?.providerCustomerId, customerId)

    const ledger = await BillingProcessedEvent.find('evt_checkout_create')
    assert.equal(ledger?.status, 'completed')
  })

  test('subscription.created resolves the tenant via the mapping just created', async ({
    assert,
    client,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const customerId = `cus_${randomUUID().slice(0, 8)}`

    // 1. Checkout completes → customer mapping written.
    await postSignedEvent(
      client,
      buildEvent(
        'checkout.session.completed',
        buildCheckoutSession({ tenantId: tenant.id, customerId }),
        { id: 'evt_co_then_sub_1' }
      )
    )
    await flushJobs()
    assert.isNotNull(await BillingCustomer.find(tenant.id))

    // 2. Subscription created for the same customer → must resolve the
    //    tenant via the mapping (would throw tenant_not_resolvable
    //    otherwise).
    const subId = `sub_${randomUUID().slice(0, 8)}`
    await postSignedEvent(
      client,
      buildEvent(
        'customer.subscription.created',
        buildSubscription({
          id: subId,
          customer: customerId,
          productId: 'prod_pro',
          status: 'active',
        }),
        { id: 'evt_co_then_sub_2', created: Math.floor(Date.now() / 1000) + 5 }
      )
    )
    await flushJobs()

    const mirror = await BillingSubscription.find(subId)
    assert.isNotNull(mirror, 'subscription mirror created')
    assert.equal(mirror?.tenantId, tenant.id)
    assert.equal(mirror?.planName, 'pro')

    const subLedger = await BillingProcessedEvent.find('evt_co_then_sub_2')
    assert.equal(
      subLedger?.status,
      'completed',
      'subscription event processed without a resolution error'
    )
    assert.isNull(subLedger?.lastError)
  })

  test('a different customer id for an existing mapping is logged, not overwritten', async ({
    assert,
    client,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)

    // Pre-existing mapping.
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = 'cus_original_A'
    await cus.save()

    // Checkout fires with a DIFFERENT customer id (operator misconfig:
    // two checkouts for the same tenant created distinct customers).
    await postSignedEvent(
      client,
      buildEvent(
        'checkout.session.completed',
        buildCheckoutSession({ tenantId: tenant.id, customerId: 'cus_different_B' }),
        { id: 'evt_co_mismatch' }
      )
    )
    await flushJobs()

    const mapping = await BillingCustomer.find(tenant.id)
    assert.equal(mapping?.providerCustomerId, 'cus_original_A', 'mapping NOT overwritten')

    const ledger = await BillingProcessedEvent.find('evt_co_mismatch')
    assert.equal(ledger?.status, 'completed', 'still acked — handler returns noop, not an error')
  })

  test('non-subscription/payment checkout modes are a no-op (no mapping written)', async ({
    assert,
    client,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)

    // `setup` mode (e.g. saving a card without a charge) — handler bails.
    const event = buildEvent(
      'checkout.session.completed',
      {
        ...buildCheckoutSession({
          tenantId: tenant.id,
          customerId: `cus_${randomUUID().slice(0, 8)}`,
        }),
        mode: 'setup',
      },
      { id: 'evt_co_setup_mode' }
    )
    await postSignedEvent(client, event)
    await flushJobs()

    assert.isNull(
      await BillingCustomer.find(tenant.id),
      'no mapping for a non-subscription/payment session'
    )
    assert.equal((await BillingProcessedEvent.find('evt_co_setup_mode'))?.status, 'completed')
  })
})
