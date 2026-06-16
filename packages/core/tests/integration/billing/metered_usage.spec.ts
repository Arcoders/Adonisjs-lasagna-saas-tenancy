import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe } from '@adonisjs-lasagna/billing'
import { BillingCustomer, BillingUsageEvent } from '@adonisjs-lasagna/billing'
import UsageAutoBridgeListener from '../../../../../packages/billing/build/src/listeners/usage_auto_bridge_listener.js'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables, hydrateJob } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import QuotaTracked from '../../../src/events/quota_tracked.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Two layers in the metered-billing path:
 *
 *   1. `BillingService.reportUsage` — the always-available manual API.
 *      Persists `billing_usage_events` row (UNIQUE idempotency_key) and
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
    await billing.__resetForTests()
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

    const providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()

    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    await billing.__setStripeForTests(mock)

    await billing.reportUsage(fakeTenant, { eventName: 'api_request' }, 5, {
      idempotencyKey: 'manual-key-1',
    })

    const events = mock.meterEvents()
    assert.lengthOf(events, 1)
    assert.equal(events[0].event_name, 'api_request')
    assert.equal(events[0].payload.value, '5')
    assert.equal(events[0].payload.stripe_customer_id, providerCustomerId)
    assert.equal(events[0].key, 'manual-key-1')

    const audit = await BillingUsageEvent.query().where('tenant_id', tenant.id)
    assert.lengthOf(audit, 1)
    assert.equal(audit[0].status, 'sent')
    assert.equal(audit[0].quantity, 5)
    assert.equal(audit[0].idempotencyKey, 'manual-key-1')
  })

  test('reportUsage with same idempotency key is idempotent (G-6)', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()

    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    await billing.__setStripeForTests(mock)

    await billing.reportUsage(fakeTenant, { eventName: 'api_request' }, 1, {
      idempotencyKey: 'replayed',
    })
    // After G-6 the duplicate call short-circuits silently rather than
    // throwing. The first attempt's audit row is in 'sent' state; we
    // detect it and return without re-hitting Stripe. This is what a
    // caller retrying after a transient client-side failure expects.
    await billing.reportUsage(fakeTenant, { eventName: 'api_request' }, 1, {
      idempotencyKey: 'replayed',
    })

    const events = mock.meterEvents()
    assert.lengthOf(events, 1, 'exactly one Stripe meter event despite the retry')
  })

  test('reportUsage recovers a pending audit row left by a prior DB blip (G-6)', async ({
    assert,
  }) => {
    // Simulate the failure mode the audit's BUG #1 / G-6 calls out:
    // first attempt successfully reported to Stripe but the second
    // save() (status=pending → sent) was lost to a DB hiccup, leaving
    // the audit row stuck in 'pending'. A retry must finalise it
    // rather than throwing on the UNIQUE(idempotency_key) constraint.
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()

    // Pre-seed the audit row in the post-blip state.
    const orphan = new BillingUsageEvent()
    orphan.id = randomUUID()
    orphan.tenantId = tenant.id
    orphan.meterEventName = 'api_request'
    orphan.quantity = 5
    orphan.idempotencyKey = 'recovered_after_blip'
    orphan.status = 'pending'
    orphan.attempts = 0
    orphan.lastError = null
    orphan.reportedAt = null
    await orphan.save()

    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    await billing.__setStripeForTests(mock)

    await billing.reportUsage(fakeTenant, { eventName: 'api_request' }, 5, {
      idempotencyKey: 'recovered_after_blip',
    })

    const finalised = await BillingUsageEvent.find(orphan.id)
    assert.equal(finalised?.status, 'sent', 'orphaned pending row was finalised')
    assert.isNotNull(finalised?.reportedAt)
    assert.equal(mock.meterEvents().length, 1, 'one Stripe call from the recovery')
  })

  test('reportUsage rejects negative or non-finite quantities', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      email: tenant.email,
      name: tenant.name,
    } as unknown as TenantModelContract

    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    await cus.save()

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    await assert.rejects(() => billing.reportUsage(fakeTenant, { eventName: 'x' }, -1))
    await assert.rejects(() => billing.reportUsage(fakeTenant, { eventName: 'x' }, Number.NaN))
    await assert.rejects(() => billing.reportUsage(fakeTenant, { eventName: 'x' }, Infinity))
  })

  test('emitter wires QuotaTracked → listener aggregates into one batch dispatch', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    // Resolve the listener via the container so it shares the singleton
    // instance the provider would register at start(). We then subscribe
    // it to the emitter ourselves — same call shape as
    // `MultitenancyProvider.#wireBillingListeners`. If a future refactor
    // changes the wiring signature, this test breaks loudly.
    const emitter = (await import('@adonisjs/core/services/emitter')).default
    const listener = await app.container.make(UsageAutoBridgeListener)

    const ReportUsageBatchJob = (
      await import('../../../../../packages/billing/build/src/jobs/report_usage_batch_job.js')
    ).default
    const dispatched: Array<{ tenantId: string; meterEventName: string; quantity: number }> = []
    const originalDispatch = (
      ReportUsageBatchJob as unknown as { dispatch: (...a: unknown[]) => Promise<void> }
    ).dispatch
    ;(
      ReportUsageBatchJob as unknown as {
        dispatch: (p: {
          tenantId: string
          meterEventName: string
          quantity: number
        }) => Promise<void>
      }
    ).dispatch = async (p) => {
      dispatched.push(p)
    }

    const off = emitter.on(QuotaTracked, async (event) => {
      await listener.handle(event)
    })

    try {
      // Drive QuotaTracked through the REAL emitter — no `.handle()`
      // shortcut. This proves both that (a) the listener wires correctly
      // and (b) it aggregates across emit calls.
      await emitter.emit(QuotaTracked, new QuotaTracked(fakeTenant, 'apiRequests', 1, 1))
      await emitter.emit(QuotaTracked, new QuotaTracked(fakeTenant, 'apiRequests', 2, 3))
      await emitter.emit(QuotaTracked, new QuotaTracked(fakeTenant, 'apiRequests', 5, 8))

      // Force flush (don't wait for the timer in tests).
      await listener.drainAll()

      assert.lengthOf(dispatched, 1, 'exactly one batch job dispatched')
      assert.equal(dispatched[0].tenantId, tenant.id)
      assert.equal(dispatched[0].meterEventName, 'api_request')
      assert.equal(dispatched[0].quantity, 8, 'sum of all amounts')
    } finally {
      off()
      ;(
        ReportUsageBatchJob as unknown as {
          dispatch: typeof originalDispatch
        }
      ).dispatch = originalDispatch
      await listener.drainAll().catch(() => {})
    }
  })

  test('auto-bridge: ReportUsageBatchJob.execute reports the aggregated quantity to Stripe + audit row', async ({
    assert,
  }) => {
    // The aggregation half (QuotaTracked → one dispatch with the summed
    // quantity) is covered by the test above. This covers the half that
    // test stubs out: actually executing the batch job — it must reach
    // Stripe with the aggregated quantity and persist a `sent` audit row.
    //
    // Import the job from the PACKAGE path (build), not src/, so its
    // `app.container.make(BillingService)` resolves the same singleton we
    // inject the mock into (the dual-module hazard the CLAUDE.md warns
    // about — a src/ copy would resolve a fresh, un-mocked instance).
    const { ReportUsageBatchJob } = await import('@adonisjs-lasagna/billing')

    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()

    const mock = new MockStripe('whsec_test_billing_helper')
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(mock)

    const job = new ReportUsageBatchJob()
    hydrateJob(job, { tenantId: tenant.id, meterEventName: 'api_request', quantity: 7 })
    await job.execute()

    const reported = mock.meterEvents()
    assert.lengthOf(reported, 1, 'batch job forwarded one meter event to Stripe')
    assert.equal(reported[0].event_name, 'api_request')
    assert.equal(reported[0].payload.value, '7', 'aggregated quantity reached Stripe')
    assert.equal(reported[0].payload.stripe_customer_id, providerCustomerId)

    const audit = await BillingUsageEvent.query().where('tenant_id', tenant.id)
    assert.lengthOf(audit, 1, 'one audit row written by the batch job')
    assert.equal(audit[0].status, 'sent')
    assert.equal(audit[0].quantity, 7)
    assert.equal(audit[0].meterEventName, 'api_request')
  })

  test('auto-bridge: a batch job whose tenant no longer exists drops cleanly', async ({
    assert,
  }) => {
    // The repo lookup in ReportUsageBatchJob can race a tenant delete:
    // the QuotaTracked was buffered while the tenant existed, then it was
    // hard-deleted before the bucket flushed. The job must bail (log
    // tenant_missing), not throw, and write no audit row.
    const { ReportUsageBatchJob } = await import('@adonisjs-lasagna/billing')

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const ghostTenantId = randomUUID()
    const job = new ReportUsageBatchJob()
    hydrateJob(job, { tenantId: ghostTenantId, meterEventName: 'api_request', quantity: 9 })

    await job.execute() // must not throw

    const audit = await BillingUsageEvent.query().where('tenant_id', ghostTenantId)
    assert.lengthOf(audit, 0, 'no audit row for a vanished tenant')
  })

  test('emitted QuotaTracked for an unmapped quota produces no batch', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const emitter = (await import('@adonisjs/core/services/emitter')).default
    const listener = await app.container.make(UsageAutoBridgeListener)
    const ReportUsageBatchJob = (
      await import('../../../../../packages/billing/build/src/jobs/report_usage_batch_job.js')
    ).default
    let dispatchedCount = 0
    const originalDispatch = (
      ReportUsageBatchJob as unknown as { dispatch: (...a: unknown[]) => Promise<void> }
    ).dispatch
    ;(ReportUsageBatchJob as unknown as { dispatch: () => Promise<void> }).dispatch = async () => {
      dispatchedCount += 1
    }

    const off = emitter.on(QuotaTracked, async (event) => {
      await listener.handle(event)
    })

    try {
      await emitter.emit(QuotaTracked, new QuotaTracked(fakeTenant, 'unmappedQuota', 100, 100))
      await listener.drainAll()
      assert.equal(dispatchedCount, 0, 'emitter delivered, listener saw it, but no batch')
    } finally {
      off()
      ;(
        ReportUsageBatchJob as unknown as {
          dispatch: typeof originalDispatch
        }
      ).dispatch = originalDispatch
    }
  })
})
