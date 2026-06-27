import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/billing'
import { BillingCustomer, BillingInvoiceSnapshot } from '@adonisjs-lasagna/billing'
import { BillingInvoiceController } from '@adonisjs-lasagna/billing'
import { ProcessBillingEventJob } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, buildEvent, clearBillingTables, hydrateJob } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type Stripe from 'stripe'

/**
 * B3/B4: when fiscal features are enabled, `invoice.payment_succeeded` writes an
 * append-only `billing_invoice_snapshots` row carrying the provider's tax
 * breakdown (we never compute tax). When fiscal is disabled, nothing is written.
 * Driven through the real webhook chain (POST signed → controller → job →
 * dispatcher), like the other dispatcher specs.
 */
test.group('Fiscal invoice snapshot (integration)', (group) => {
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
      ProcessBillingEventJob as unknown as { dispatch: (p: { eventId: string }) => Promise<void> }
    ).dispatch = async (p) => {
      pendingJobs.push(p.eventId)
    }
  })

  group.each.teardown(async () => {
    ;(ProcessBillingEventJob as unknown as { dispatch: typeof originalDispatch }).dispatch =
      originalDispatch
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  function enableFiscal(): void {
    setConfig({
      ...getConfig(),
      billing: { ...getConfig().billing!, fiscal: { enabled: true } },
    } as never)
  }

  async function flushJobs(): Promise<void> {
    while (pendingJobs.length) {
      const eventId = pendingJobs.shift()!
      const job = new ProcessBillingEventJob()
      hydrateJob(job, { eventId })
      await job.execute()
    }
  }

  async function postPaymentSucceeded(
    client: { post: (path: string) => any },
    eventId: string,
    invoiceId: string,
    customerId: string
  ): Promise<void> {
    const invoice = {
      id: invoiceId,
      object: 'invoice',
      customer: customerId,
      amount_paid: 1200,
      amount_due: 1200,
      currency: 'eur',
      subtotal: 1000,
      tax: 200,
      total: 1200,
      attempt_count: 1,
      next_payment_attempt: null,
    } as unknown as Stripe.Invoice
    const event = buildEvent('invoice.payment_succeeded', invoice, { id: eventId })
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

  async function seedCustomer(): Promise<{ tenantId: string; customerId: string }> {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const customerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = customerId
    await cus.save()
    return { tenantId: tenant.id, customerId }
  }

  test('writes a snapshot with the provider tax breakdown when fiscal is enabled', async ({
    assert,
    client,
  }) => {
    enableFiscal()
    const { tenantId, customerId } = await seedCustomer()

    await postPaymentSucceeded(client, 'evt_fiscal_1', 'in_fiscal_1', customerId)
    await flushJobs()

    const rows = await BillingInvoiceSnapshot.query().where('tenantId', tenantId)
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].providerInvoiceId, 'in_fiscal_1')
    assert.equal(rows[0].subtotalCents, 1000)
    assert.equal(rows[0].taxCents, 200)
    assert.equal(rows[0].totalCents, 1200)
    assert.equal(rows[0].currency, 'eur')
  })

  test('is idempotent — a redelivered invoice does not duplicate the snapshot', async ({
    assert,
    client,
  }) => {
    enableFiscal()
    const { tenantId, customerId } = await seedCustomer()

    await postPaymentSucceeded(client, 'evt_fiscal_2', 'in_fiscal_dup', customerId)
    await flushJobs()
    // Same invoice id, different event id (a provider redelivery).
    await postPaymentSucceeded(client, 'evt_fiscal_2b', 'in_fiscal_dup', customerId)
    await flushJobs()

    const rows = await BillingInvoiceSnapshot.query().where('tenantId', tenantId)
    assert.lengthOf(rows, 1, 'unique (provider, provider_invoice_id) collapses the redelivery')
  })

  test('writes nothing when fiscal is disabled (default)', async ({ assert, client }) => {
    const { tenantId, customerId } = await seedCustomer()

    await postPaymentSucceeded(client, 'evt_nofiscal', 'in_nofiscal', customerId)
    await flushJobs()

    const rows = await BillingInvoiceSnapshot.query().where('tenantId', tenantId)
    assert.lengthOf(rows, 0)
  })

  test('the read-through controller lists tenant snapshots and redirects to the pdf', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)

    const snap = new BillingInvoiceSnapshot()
    snap.id = randomUUID()
    snap.provider = 'stripe'
    snap.providerInvoiceId = 'in_read_1'
    snap.tenantId = tenant.id
    snap.currency = 'eur'
    snap.subtotalCents = 1000
    snap.taxCents = 200
    snap.totalCents = 1200
    snap.status = 'paid'
    snap.pdfUrl = 'https://pay.stripe.test/in_read_1.pdf'
    snap.issuedAt = DateTime.utc()
    await snap.save()

    // Seed another tenant's snapshot to prove scoping.
    const other = await createTestTenant()
    cleanupTenants.push(other.id)
    const otherSnap = new BillingInvoiceSnapshot()
    otherSnap.id = randomUUID()
    otherSnap.provider = 'stripe'
    otherSnap.providerInvoiceId = 'in_other'
    otherSnap.tenantId = other.id
    otherSnap.currency = 'usd'
    otherSnap.subtotalCents = 1
    otherSnap.taxCents = 0
    otherSnap.totalCents = 1
    otherSnap.status = 'paid'
    otherSnap.pdfUrl = null
    otherSnap.issuedAt = DateTime.utc()
    await otherSnap.save()

    const controller = new BillingInvoiceController()

    const list = fakeHttpContext(tenant.id)
    await controller.index(list.ctx)
    const body = list.captured.json as { invoices: Array<Record<string, unknown>> }
    assert.lengthOf(body.invoices, 1, 'scoped to the requesting tenant only')
    assert.equal(body.invoices[0].id, 'in_read_1')
    assert.equal(body.invoices[0].tax, 200)
    assert.equal(body.invoices[0].total, 1200)

    const pdf = fakeHttpContext(tenant.id, { id: 'in_read_1' })
    await controller.pdf(pdf.ctx)
    assert.equal(pdf.captured.redirect, 'https://pay.stripe.test/in_read_1.pdf')

    const missing = fakeHttpContext(tenant.id, { id: 'does_not_exist' })
    await controller.pdf(missing.ctx)
    assert.isObject(missing.captured.notFound, 'unknown invoice → 404')
  })
})

/**
 * Minimal HttpContext double for the read-through controller: a `request.tenant()`
 * resolving to a fixed tenant (the host's auth/tenant middleware does this in
 * production) and a response capturing json / redirect / notFound. Avoids
 * standing up a full route + middleware stack for two thin read handlers.
 */
function fakeHttpContext(tenantId: string, params: Record<string, string> = {}) {
  const captured: { json?: unknown; redirect?: string; notFound?: unknown } = {}
  const ctx = {
    request: { tenant: async () => ({ id: tenantId }) },
    params,
    response: {
      json: (x: unknown) => {
        captured.json = x
        return x
      },
      redirect: (url: string) => {
        captured.redirect = url
        return url
      },
      notFound: (x: unknown) => {
        captured.notFound = x
        return x
      },
    },
  }
  return { ctx: ctx as unknown as Parameters<BillingInvoiceController['index']>[0], captured }
}
