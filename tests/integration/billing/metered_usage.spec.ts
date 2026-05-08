import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { BillingService, QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe } from '@adonisjs-lasagna/saas-tenancy/testing'
import { StripeCustomer, StripeMeterEvent } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import UsageAutoBridgeListener from '../../../src/listeners/usage_auto_bridge_listener.js'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import QuotaTracked from '../../../src/events/quota_tracked.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Two layers in the metered-billing path:
 *
 *   1. `BillingService.reportUsage` — the always-available manual API.
 *      Persists `stripe_meter_events` row (UNIQUE idempotency_key) and
 *      forwards to Stripe with the same key, so retries never produce
 *      duplicate meter events.
 *
 *   2. `UsageAutoBridgeListener` — opt-in aggregator. Buffers
 *      `QuotaTracked` events per (tenant, meter) and dispatches a single
 *      `ReportUsageBatchJob` per `batchFlushMs`. Drains on shutdown.
 *
 * We test both. The bridge dispatches the batch job, which we verify by
 * stubbing the dispatch call.
 */
test.group('Metered/usage-based billing (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({
      defaultPlan: 'starter',
      usageMapping: {
        apiRequests: { meterEventName: 'api_request' },
      },
    })
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
    billing.__resetForTests()
  })

  test('reportUsage persists audit row + forwards to Stripe with idempotency key', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    billing.__setStripeForTests(mock)

    await billing.reportUsage(fakeTenant, { eventName: 'api_request' }, 5, {
      idempotencyKey: 'manual-key-1',
    })

    const events = mock.meterEvents()
    assert.lengthOf(events, 1)
    assert.equal(events[0].event_name, 'api_request')
    assert.equal(events[0].payload.value, '5')
    assert.equal(events[0].payload.stripe_customer_id, stripeCustomerId)
    assert.equal(events[0].key, 'manual-key-1')

    const audit = await StripeMeterEvent.query().where('tenant_id', tenant.id)
    assert.lengthOf(audit, 1)
    assert.equal(audit[0].status, 'sent')
    assert.equal(audit[0].quantity, 5)
    assert.equal(audit[0].idempotencyKey, 'manual-key-1')
  })

  test('reportUsage with same idempotency key collapses to one Stripe call', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    billing.__setStripeForTests(mock)

    await billing.reportUsage(fakeTenant, { eventName: 'api_request' }, 1, {
      idempotencyKey: 'replayed',
    })
    // The local UNIQUE constraint refuses the second insert; the call
    // throws before reaching Stripe. That's the intended behaviour —
    // duplicate idempotency keys are an operator bug.
    await assert.rejects(
      () =>
        billing.reportUsage(fakeTenant, { eventName: 'api_request' }, 1, {
          idempotencyKey: 'replayed',
        })
    )

    const events = mock.meterEvents()
    assert.lengthOf(events, 1, 'exactly one Stripe meter event despite the retry')
  })

  test('reportUsage rejects negative or non-finite quantities', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = { id: tenant.id, email: tenant.email, name: tenant.name } as unknown as TenantModelContract

    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    await cus.save()

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    await assert.rejects(() => billing.reportUsage(fakeTenant, { eventName: 'x' }, -1))
    await assert.rejects(() => billing.reportUsage(fakeTenant, { eventName: 'x' }, Number.NaN))
    await assert.rejects(() => billing.reportUsage(fakeTenant, { eventName: 'x' }, Infinity))
  })

  test('UsageAutoBridgeListener aggregates QuotaTracked into a single batch dispatch', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const listener = new UsageAutoBridgeListener()

    // Stub the dispatch capture by replacing the static .dispatch on
    // ReportUsageBatchJob.
    const ReportUsageBatchJob = (
      await import('../../../src/jobs/report_usage_batch_job.js')
    ).default
    const dispatched: Array<{ tenantId: string; meterEventName: string; quantity: number }> = []
    const originalDispatch = (
      ReportUsageBatchJob as unknown as { dispatch: (...a: unknown[]) => Promise<void> }
    ).dispatch
    ;(ReportUsageBatchJob as unknown as {
      dispatch: (p: { tenantId: string; meterEventName: string; quantity: number }) => Promise<void>
    }).dispatch = async (p) => {
      dispatched.push(p)
    }

    try {
      // Three QuotaTracked events for the same (tenant, meter) — should
      // collapse to one batch.
      await listener.handle(new QuotaTracked(fakeTenant, 'apiRequests', 1, 1))
      await listener.handle(new QuotaTracked(fakeTenant, 'apiRequests', 2, 3))
      await listener.handle(new QuotaTracked(fakeTenant, 'apiRequests', 5, 8))

      // Force flush (don't wait for the timer in tests).
      await listener.drainAll()

      assert.lengthOf(dispatched, 1, 'exactly one batch job dispatched')
      assert.equal(dispatched[0].tenantId, tenant.id)
      assert.equal(dispatched[0].meterEventName, 'api_request')
      assert.equal(dispatched[0].quantity, 8, 'sum of all amounts')
    } finally {
      ;(ReportUsageBatchJob as unknown as {
        dispatch: typeof originalDispatch
      }).dispatch = originalDispatch
    }
  })

  test('UsageAutoBridgeListener ignores quotas without a meter mapping', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const listener = new UsageAutoBridgeListener()
    const ReportUsageBatchJob = (
      await import('../../../src/jobs/report_usage_batch_job.js')
    ).default
    let dispatchedCount = 0
    const originalDispatch = (
      ReportUsageBatchJob as unknown as { dispatch: (...a: unknown[]) => Promise<void> }
    ).dispatch
    ;(ReportUsageBatchJob as unknown as { dispatch: () => Promise<void> }).dispatch = async () => {
      dispatchedCount += 1
    }

    try {
      // `unmappedQuota` has no entry in usageMapping → listener skips.
      await listener.handle(new QuotaTracked(fakeTenant, 'unmappedQuota', 100, 100))
      await listener.drainAll()
      assert.equal(dispatchedCount, 0)
    } finally {
      ;(ReportUsageBatchJob as unknown as {
        dispatch: typeof originalDispatch
      }).dispatch = originalDispatch
    }
  })
})
