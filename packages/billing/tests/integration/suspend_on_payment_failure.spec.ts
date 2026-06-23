import { test } from '@japa/runner'
import emitter from '@adonisjs/core/services/emitter'
import { randomUUID } from 'node:crypto'
import { TenantSuspended, TenantActivated } from '@adonisjs-lasagna/saas-tenancy/events'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import PaymentFailed from '../../src/events/billing/payment_failed.js'
import SubscriptionCanceled from '../../src/events/billing/subscription_canceled.js'
import PaymentSucceeded from '../../src/events/billing/payment_succeeded.js'
import SuspendOnPaymentFailureListener from '../../src/listeners/suspend_on_payment_failure_listener.js'
import ReactivateOnPaymentSuccessListener from '../../src/listeners/reactivate_on_payment_success_listener.js'

/**
 * Opt-in auto-suspend/reactivate on billing failure. The listeners are exercised
 * directly (not via the emitter) so the assertions don't depend on the
 * provider's lazy wiring — that wiring is a one-liner gated on the same flags.
 */
test.group('suspend_on_payment_failure (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>
  let suspended: string[] = []
  let activated: string[] = []
  let offSuspended: (() => void) | undefined
  let offActivated: (() => void) | undefined

  function withFlags(flags: { suspend?: boolean; reactivate?: boolean }): void {
    const cfg = getConfig()
    setConfig({
      ...cfg,
      billing: {
        ...cfg.billing!,
        suspendOnPaymentFailure: flags.suspend ?? false,
        reactivateOnPaymentSuccess: flags.reactivate ?? false,
      },
    } as never)
  }

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()
    suspended = []
    activated = []
    offSuspended = emitter.on(TenantSuspended, (e) => {
      suspended.push(e.tenant.id)
    })
    offActivated = emitter.on(TenantActivated, (e) => {
      activated.push(e.tenant.id)
    })
  })

  group.each.teardown(async () => {
    offSuspended?.()
    offActivated?.()
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
  })

  function paymentFailed(tenantId: string, final: boolean): PaymentFailed {
    return new PaymentFailed({
      tenantId,
      invoiceId: null,
      amount: 999,
      currency: 'usd',
      attempts: final ? 4 : 1,
      final,
      nextRetry: final ? null : new Date(Date.now() + 86_400_000).toISOString(),
    })
  }

  async function statusOf(id: string): Promise<string> {
    const repo = await resolveTenantRepository()
    const t = await repo.findByIdOrFail(id, true)
    return t.status
  }

  test('flag disabled: PaymentFailed{final:true} does not suspend', async ({ assert }) => {
    withFlags({ suspend: false })
    const t = await createTestTenant()
    cleanupTenants.push(t.id)

    await new SuspendOnPaymentFailureListener().handlePaymentFailed(paymentFailed(t.id, true))

    assert.equal(await statusOf(t.id), 'active')
    assert.lengthOf(suspended, 0)
  })

  test('PaymentFailed{final:true} suspends and dispatches TenantSuspended', async ({ assert }) => {
    withFlags({ suspend: true })
    const t = await createTestTenant()
    cleanupTenants.push(t.id)

    await new SuspendOnPaymentFailureListener().handlePaymentFailed(paymentFailed(t.id, true))

    assert.equal(await statusOf(t.id), 'suspended')
    assert.deepEqual(suspended, [t.id])
  })

  test('PaymentFailed{final:false} does not suspend (still in dunning window)', async ({
    assert,
  }) => {
    withFlags({ suspend: true })
    const t = await createTestTenant()
    cleanupTenants.push(t.id)

    await new SuspendOnPaymentFailureListener().handlePaymentFailed(paymentFailed(t.id, false))

    assert.equal(await statusOf(t.id), 'active')
    assert.lengthOf(suspended, 0)
  })

  test('SubscriptionCanceled{reason:dunning_failed} suspends; user_canceled does not', async ({
    assert,
  }) => {
    withFlags({ suspend: true })
    const listener = new SuspendOnPaymentFailureListener()

    const dunned = await createTestTenant()
    cleanupTenants.push(dunned.id)
    await listener.handleSubscriptionCanceled(
      new SubscriptionCanceled({
        tenantId: dunned.id,
        subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        previousPlan: 'pro',
        reason: 'dunning_failed',
      })
    )
    assert.equal(await statusOf(dunned.id), 'suspended')

    const churned = await createTestTenant()
    cleanupTenants.push(churned.id)
    await listener.handleSubscriptionCanceled(
      new SubscriptionCanceled({
        tenantId: churned.id,
        subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        previousPlan: 'pro',
        reason: 'user_canceled',
      })
    )
    assert.equal(await statusOf(churned.id), 'active')
  })

  test('idempotent: an already-suspended tenant does not re-dispatch', async ({ assert }) => {
    withFlags({ suspend: true })
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    const repo = await resolveTenantRepository()
    await (await repo.findByIdOrFail(t.id)).suspend()
    suspended = []

    await new SuspendOnPaymentFailureListener().handlePaymentFailed(paymentFailed(t.id, true))

    assert.equal(await statusOf(t.id), 'suspended')
    assert.lengthOf(suspended, 0, 'no second TenantSuspended dispatch')
  })

  test('concurrent terminal failures converge to suspended with bounded dispatch (best-effort)', async ({
    assert,
  }) => {
    withFlags({ suspend: true })
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    const listener = new SuspendOnPaymentFailureListener()

    // Three duplicate terminal events race. The in-memory isSuspended check is
    // not transactional, so dispatch is at-least-once (not exactly-once) — the
    // documented best-effort contract. State must still converge to suspended.
    await Promise.allSettled([
      listener.handlePaymentFailed(paymentFailed(t.id, true)),
      listener.handlePaymentFailed(paymentFailed(t.id, true)),
      listener.handlePaymentFailed(paymentFailed(t.id, true)),
    ])

    assert.equal(await statusOf(t.id), 'suspended')
    assert.isAtLeast(suspended.length, 1, 'at least one TenantSuspended dispatch')
    assert.isAtMost(suspended.length, 3, 'dispatch bounded by the racers')
  })

  test('PaymentSucceeded reactivates a suspended tenant when reactivate flag is on', async ({
    assert,
  }) => {
    withFlags({ suspend: true, reactivate: true })
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    const repo = await resolveTenantRepository()
    await (await repo.findByIdOrFail(t.id)).suspend()

    await new ReactivateOnPaymentSuccessListener().handle(
      new PaymentSucceeded({ tenantId: t.id, invoiceId: 'in_1', amount: 999, currency: 'usd' })
    )

    assert.equal(await statusOf(t.id), 'active')
    assert.deepEqual(activated, [t.id])
  })

  test('PaymentSucceeded does not reactivate when reactivate flag is off', async ({ assert }) => {
    withFlags({ suspend: true, reactivate: false })
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    const repo = await resolveTenantRepository()
    await (await repo.findByIdOrFail(t.id)).suspend()

    await new ReactivateOnPaymentSuccessListener().handle(
      new PaymentSucceeded({ tenantId: t.id, invoiceId: 'in_1', amount: 999, currency: 'usd' })
    )

    assert.equal(await statusOf(t.id), 'suspended')
    assert.lengthOf(activated, 0)
  })
})
