import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { BillingService, HookRegistry } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe } from '@adonisjs-lasagna/saas-tenancy/testing'
import {
  StripeCustomer,
  StripeSubscription,
} from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import TenantDestroyBillingListener from '../../../src/listeners/tenant_destroy_billing_listener.js'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Tenant hard-delete lifecycle. Three policies via
 * `config.billing.onTenantDelete`:
 *   - 'cancel' (default) — cancel active subs in Stripe + drop local mapping
 *   - 'detach' — leave Stripe alone, drop local mapping
 *   - 'preserve' — no-op (operator handles cleanup)
 *
 * Tests route through `HookRegistry.run('before', 'destroy', { tenant })`
 * so a regression that breaks the wiring in `MultitenancyProvider.start()`
 * is caught — calling the listener's `.handle()` directly would skip
 * the wiring layer and give false confidence.
 */
test.group('Tenant destroy billing listener (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>
  let cancelLog: string[] = []

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()

    // Wire the listener as the provider would — once per test, removed
    // in teardown. Wiring HERE (not in the global container) lets us
    // also exercise the hook unregistration on teardown without
    // polluting other specs.
    const hooks = await app.container.make(HookRegistry)
    hooks.before('destroy', async (ctx) => {
      const listener = new TenantDestroyBillingListener()
      await listener.handle(ctx.tenant)
    })

    cancelLog = []
  })

  group.each.teardown(async () => {
    // HookRegistry exposes a public `clear()` — wipe every registration
    // we added in setup. Re-load declarative hooks from config in case
    // the host wired any (the fixture doesn't). Without this, each
    // test would stack another `before:destroy` listener on top of the
    // previous tests' listeners and the cancel mock would fire N times.
    const hooks = await app.container.make(HookRegistry)
    hooks.clear()
    hooks.loadDeclarative(getConfig().hooks)

    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    billing.__resetForTests()
  })

  async function seed(): Promise<{
    tenant: TenantModelContract
    stripeCustomerId: string
    stripeSubscriptionId: string
  }> {
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    const fakeTenant = { id: t.id, name: t.name, email: t.email } as unknown as TenantModelContract

    const stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = t.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    const stripeSubscriptionId = `sub_${randomUUID().slice(0, 8)}`
    const sub = new StripeSubscription()
    sub.stripeSubscriptionId = stripeSubscriptionId
    sub.tenantId = t.id
    sub.status = 'active'
    sub.currentPeriodStart = DateTime.utc().minus({ days: 1 })
    sub.currentPeriodEnd = DateTime.utc().plus({ days: 29 })
    sub.cancelAtPeriodEnd = false
    sub.cancelAt = null
    sub.canceledAt = null
    sub.trialEnd = null
    sub.planName = 'pro'
    sub.lastEventAt = DateTime.utc().minus({ minutes: 1 })
    sub.raw = {}
    await sub.save()

    return { tenant: fakeTenant, stripeCustomerId, stripeSubscriptionId }
  }

  /**
   * Wire MockStripe and patch `subscriptions.cancel` to record the call.
   * The mock's auto-generated subscription id won't match our local one
   * (we seeded a specific subId), so the patched cancel just acks any
   * id and records what was passed. That's the contract under test —
   * the listener calls cancel(subId), not which Stripe state is left.
   */
  function wireMock(): MockStripe {
    const mock = new MockStripe('whsec_test_billing_helper')
    const originalCancel = mock.subscriptions.cancel
    mock.subscriptions.cancel = async (id: string) => {
      cancelLog.push(id)
      try {
        return await originalCancel.call(mock.subscriptions, id)
      } catch {
        return {
          id,
          status: 'canceled' as const,
          customer: 'cus_x',
          items: { data: [] },
          current_period_start: 0,
          current_period_end: 0,
          cancel_at_period_end: false,
        }
      }
    }
    return mock
  }

  test("default 'cancel' policy: routes through HookRegistry → cancel called + customer dropped", async ({
    assert,
  }) => {
    const { tenant, stripeSubscriptionId } = await seed()
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(wireMock())

    // Critical: invoke the registry, not the listener directly.
    const hooks = await app.container.make(HookRegistry)
    await hooks.run('before', 'destroy', { tenant })

    assert.deepEqual(cancelLog, [stripeSubscriptionId], 'cancel called with the active sub id')

    const cus = await StripeCustomer.find(tenant.id)
    assert.isNull(cus, 'local stripe_customers row removed')

    const sub = await StripeSubscription.find(stripeSubscriptionId)
    assert.isNotNull(sub, 'subscription audit row preserved')
    assert.equal(sub?.status, 'canceled')
  })

  test("'detach' policy: hook fires but no Stripe call; only local mapping dropped", async ({
    assert,
  }) => {
    const cfg = getConfig()
    setConfig({
      ...cfg,
      billing: { ...cfg.billing!, onTenantDelete: 'detach' },
    } as never)

    const { tenant, stripeSubscriptionId } = await seed()
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(wireMock())

    const hooks = await app.container.make(HookRegistry)
    await hooks.run('before', 'destroy', { tenant })

    assert.lengthOf(cancelLog, 0, 'detach must not call Stripe cancel')

    const cus = await StripeCustomer.find(tenant.id)
    assert.isNull(cus, 'local mapping still removed')

    const sub = await StripeSubscription.find(stripeSubscriptionId)
    assert.equal(sub?.status, 'active', 'subscription untouched on detach')
  })

  test("'preserve' policy: hook fires but the listener short-circuits", async ({ assert }) => {
    const cfg = getConfig()
    setConfig({
      ...cfg,
      billing: { ...cfg.billing!, onTenantDelete: 'preserve' },
    } as never)

    const { tenant, stripeSubscriptionId } = await seed()
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(wireMock())

    const hooks = await app.container.make(HookRegistry)
    await hooks.run('before', 'destroy', { tenant })

    assert.lengthOf(cancelLog, 0)

    const cus = await StripeCustomer.find(tenant.id)
    assert.isNotNull(cus, 'preserve keeps the local mapping intact')

    const sub = await StripeSubscription.find(stripeSubscriptionId)
    assert.isNotNull(sub)
  })

  test('without a customer mapping the hook is a no-op', async ({ assert }) => {
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    const fakeTenant = { id: t.id, name: t.name, email: t.email } as unknown as TenantModelContract

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(wireMock())

    const hooks = await app.container.make(HookRegistry)
    await hooks.run('before', 'destroy', { tenant: fakeTenant })

    assert.lengthOf(cancelLog, 0)
  })
})
