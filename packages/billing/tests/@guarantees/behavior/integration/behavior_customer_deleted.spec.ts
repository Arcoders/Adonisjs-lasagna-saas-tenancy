import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/billing'
import { BillingCustomer, BillingProcessedEvent } from '@adonisjs-lasagna/billing'
import { ProcessBillingEventJob } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import {
  setupBillingConfig,
  buildEvent,
  clearBillingTables,
  hydrateJob,
} from '../../../helpers/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type Stripe from 'stripe'

/**
 * `customer.deleted` — Stripe fires this when a customer is deleted on
 * their side (rare, but happens via GDPR scrubs or operator tooling).
 * The handler soft-deletes the local mapping by stamping `deletedAt` so
 * a future tenant with the same id doesn't inherit billing state, and
 * the audit row is preserved.
 */
test.group('customer.deleted (integration)', (group) => {
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
      .post('/webhooks/billing')
      .header('content-type', 'application/json')
      .header('stripe-signature', sig)
      .json(event)
    res.assertStatus(200)
  }

  test('customer.deleted stamps deletedAt on the local mapping', async ({ assert, client }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()

    const event = buildEvent(
      'customer.deleted',
      { id: providerCustomerId, object: 'customer', deleted: true },
      { id: 'evt_customer_deleted' }
    )
    await postSignedEvent(client, event)
    await flushJobs()

    const refreshed = await BillingCustomer.find(tenant.id)
    assert.isNotNull(refreshed, 'mapping row kept (soft delete, not hard delete)')
    assert.isNotNull(refreshed?.deletedAt, 'deletedAt stamped')
    assert.equal(refreshed?.providerCustomerId, providerCustomerId, 'providerCustomerId unchanged')

    const ledger = await BillingProcessedEvent.find('evt_customer_deleted')
    assert.equal(ledger?.status, 'completed')
    assert.equal(ledger?.tenantId, tenant.id, 'ledger row attributed to the resolved tenant')
  })

  test('customer.deleted for an unknown customer is a no-op (no throw, no dead-letter)', async ({
    assert,
    client,
  }) => {
    const event = buildEvent(
      'customer.deleted',
      { id: `cus_never_seen_${randomUUID().slice(0, 8)}`, object: 'customer', deleted: true },
      { id: 'evt_customer_deleted_unknown' }
    )
    await postSignedEvent(client, event)
    await flushJobs() // must not throw

    const ledger = await BillingProcessedEvent.find('evt_customer_deleted_unknown')
    assert.equal(ledger?.status, 'completed', 'acked cleanly')
    assert.isNull(ledger?.lastError)
    const rows = await BillingCustomer.query()
    assert.lengthOf(rows, 0, 'nothing written')
  })
})
