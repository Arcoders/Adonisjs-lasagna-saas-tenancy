import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe } from '@adonisjs-lasagna/billing'
import {
  BillingCustomer,
  BillingProcessedEvent,
  BillingSubscription,
} from '@adonisjs-lasagna/billing'
import { billingHealthCheck } from '@adonisjs-lasagna/billing'
import { SLOW_API_THRESHOLD_MS } from '../../../../build/src/health/billing_health_check.js'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '@adonisjs-lasagna/satellite-test-kit/testing'
import { setupBillingConfig, clearBillingTables } from '../../../helpers/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'

/**
 * billingHealthCheck has 4 outcomes:
 *   - skip (billing not configured)
 *   - fail (api unreachable / secret missing / very stale processing)
 *   - degraded (slow api OR processing 5-15min stale)
 *   - pass
 */
test.group('billingHealthCheck (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
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

  test('skips when config.billing is not configured', async ({ assert }) => {
    setConfig({ ...testConfig } as never) // no billing key
    const result = await billingHealthCheck()
    assert.equal(result.status, 'pass')
    assert.equal(result.meta?.skipped, true)
  })

  test('verify() rejects an empty webhook secret (boot guard)', async ({ assert }) => {
    // Config validation lives in the driver's verifyConfig() (run at boot via
    // BillingService.verify()), not the runtime health check — the latter is a
    // liveness probe, so an empty webhook secret must be rejected there.
    setConfig({
      ...testConfig,
      plans: {
        defaultPlan: 'starter',
        definitions: { starter: { limits: {} } },
        storage: 'tenant_plans',
      },
      billing: {
        driver: 'stripe',
        stripe: { apiKey: 'sk_test_x', webhookSecret: '' }, // empty
        products: { prod_starter: 'starter' },
        defaultPlan: 'starter',
      },
    } as never)

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
    await assert.rejects(() => billing.verify(), /webhookSecret is empty/)
  })

  test('passes with no active subs (clean app)', async ({ assert }) => {
    setupBillingConfig({ defaultPlan: 'starter' })
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const result = await billingHealthCheck()
    assert.equal(result.status, 'pass')
    assert.equal(result.meta?.active_subs, 0)
  })

  test('fails when processed events are >15min stale and there are active subs', async ({
    assert,
  }) => {
    setupBillingConfig({ defaultPlan: 'starter' })
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    await cus.save()

    const sub = new BillingSubscription()
    sub.providerSubscriptionId = `sub_${randomUUID().slice(0, 8)}`
    sub.tenantId = tenant.id
    sub.status = 'active'
    sub.currentPeriodStart = DateTime.utc().minus({ days: 1 })
    sub.currentPeriodEnd = DateTime.utc().plus({ days: 29 })
    sub.cancelAtPeriodEnd = false
    sub.cancelAt = null
    sub.canceledAt = null
    sub.trialEnd = null
    sub.planName = 'starter'
    sub.lastEventAt = DateTime.utc().minus({ minutes: 1 })
    sub.raw = {}
    await sub.save()

    // Most recent completed event is 30min old → fail.
    const evt = new BillingProcessedEvent()
    evt.eventId = `evt_${randomUUID().slice(0, 8)}`
    evt.eventType = 'customer.subscription.created'
    evt.status = 'completed'
    evt.attempts = 1
    evt.lastError = null
    evt.tenantId = tenant.id
    evt.processedAt = DateTime.utc().minus({ minutes: 30 })
    evt.completedAt = DateTime.utc().minus({ minutes: 30 })
    evt.payload = null
    await evt.save()

    const result = await billingHealthCheck()
    assert.equal(result.status, 'fail')
    assert.match(result.message ?? '', /min ago/)
  })

  test('passes degraded when api is slow but everything else works', async ({ assert }) => {
    setupBillingConfig({ defaultPlan: 'starter' })
    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    // Sleep just past the exported threshold — if someone bumps the
    // threshold without updating the test, the magic number break here.
    mock.balance.retrieve = async () => {
      await new Promise((r) => setTimeout(r, SLOW_API_THRESHOLD_MS + 100))
      return { object: 'balance', available: [], pending: [] }
    }
    await billing.__setStripeForTests(mock)

    const result = await billingHealthCheck()
    assert.equal(result.status, 'pass')
    assert.equal(result.meta?.degraded, true, 'meta marks it degraded')
    assert.isAbove(
      result.meta?.api_duration_ms as number,
      SLOW_API_THRESHOLD_MS,
      'measured duration crossed the documented threshold'
    )
  }).timeout(10_000)

  test('fails when Stripe API is unreachable', async ({ assert }) => {
    setupBillingConfig({ defaultPlan: 'starter' })
    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    mock.balance.retrieve = async () => {
      throw new Error('connection refused')
    }
    await billing.__setStripeForTests(mock)

    const result = await billingHealthCheck()
    assert.equal(result.status, 'fail')
    assert.match(result.message ?? '', /unreachable/)
  })
})
