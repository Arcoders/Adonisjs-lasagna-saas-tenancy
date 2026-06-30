import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { HookRegistry } from '@adonisjs-lasagna/saas-tenancy/services'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe } from '@adonisjs-lasagna/billing'
import { BillingCustomer, BillingSubscription } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from '../../../helpers/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
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
    cancelLog = []
    // Note: the `before:destroy` listener is auto-wired by
    // `MultitenancyProvider.start()` because the fixture's
    // `config/multitenancy.ts` includes a `billing` block. Importing
    // `TenantDestroyBillingListener` from `../../../core/src/...` and
    // wiring it manually loaded a SECOND copy of the listener that
    // resolved `BillingService` against a different module-class key
    // than the one the spec mocked — the cancel mock never fired.
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

  async function seed(): Promise<{
    tenant: TenantModelContract
    providerCustomerId: string
    providerSubscriptionId: string
  }> {
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    const fakeTenant = { id: t.id, name: t.name, email: t.email } as unknown as TenantModelContract

    const providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = t.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()

    const providerSubscriptionId = `sub_${randomUUID().slice(0, 8)}`
    const sub = new BillingSubscription()
    sub.providerSubscriptionId = providerSubscriptionId
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

    return { tenant: fakeTenant, providerCustomerId, providerSubscriptionId }
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
    const { tenant, providerSubscriptionId } = await seed()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(wireMock())

    // Critical: invoke the registry, not the listener directly.
    const hooks = await app.container.make(HookRegistry)
    await hooks.run('before', 'destroy', { tenant })

    assert.deepEqual(cancelLog, [providerSubscriptionId], 'cancel called with the active sub id')

    const cus = await BillingCustomer.find(tenant.id)
    assert.isNull(cus, 'local billing_customers row removed')

    const sub = await BillingSubscription.find(providerSubscriptionId)
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

    const { tenant, providerSubscriptionId } = await seed()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(wireMock())

    const hooks = await app.container.make(HookRegistry)
    await hooks.run('before', 'destroy', { tenant })

    assert.lengthOf(cancelLog, 0, 'detach must not call Stripe cancel')

    const cus = await BillingCustomer.find(tenant.id)
    assert.isNull(cus, 'local mapping still removed')

    const sub = await BillingSubscription.find(providerSubscriptionId)
    assert.equal(sub?.status, 'active', 'subscription untouched on detach')
  })

  test("'preserve' policy: hook fires but the listener short-circuits", async ({ assert }) => {
    const cfg = getConfig()
    setConfig({
      ...cfg,
      billing: { ...cfg.billing!, onTenantDelete: 'preserve' },
    } as never)

    const { tenant, providerSubscriptionId } = await seed()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(wireMock())

    const hooks = await app.container.make(HookRegistry)
    await hooks.run('before', 'destroy', { tenant })

    assert.lengthOf(cancelLog, 0)

    const cus = await BillingCustomer.find(tenant.id)
    assert.isNotNull(cus, 'preserve keeps the local mapping intact')

    const sub = await BillingSubscription.find(providerSubscriptionId)
    assert.isNotNull(sub)
  })

  test("'cancel' policy cancels EVERY active subscription for the tenant", async ({ assert }) => {
    // A tenant may hold more than one active subscription (e.g. a base
    // plan plus an add-on product). The listener loops over all of them;
    // this exercises that loop, not just the single-sub happy path.
    const { tenant, providerSubscriptionId: subA } = await seed()

    // Seed a second active subscription for the same tenant.
    const subB = `sub_${randomUUID().slice(0, 8)}`
    const second = new BillingSubscription()
    second.providerSubscriptionId = subB
    second.tenantId = tenant.id
    second.status = 'active'
    second.currentPeriodStart = DateTime.utc().minus({ days: 2 })
    second.currentPeriodEnd = DateTime.utc().plus({ days: 28 })
    second.cancelAtPeriodEnd = false
    second.cancelAt = null
    second.canceledAt = null
    second.trialEnd = null
    second.planName = 'team'
    second.lastEventAt = DateTime.utc().minus({ minutes: 2 })
    second.raw = {}
    await second.save()

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(wireMock())

    const hooks = await app.container.make(HookRegistry)
    await hooks.run('before', 'destroy', { tenant })

    assert.deepEqual(
      [...cancelLog].sort(),
      [subA, subB].sort(),
      'cancel called for BOTH active subscriptions'
    )

    assert.equal((await BillingSubscription.find(subA))?.status, 'canceled')
    assert.equal((await BillingSubscription.find(subB))?.status, 'canceled')
    assert.isNull(await BillingCustomer.find(tenant.id), 'customer mapping dropped')
  })

  test('without a customer mapping the hook is a no-op', async ({ assert }) => {
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    const fakeTenant = { id: t.id, name: t.name, email: t.email } as unknown as TenantModelContract

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(wireMock())

    const hooks = await app.container.make(HookRegistry)
    await hooks.run('before', 'destroy', { tenant: fakeTenant })

    assert.lengthOf(cancelLog, 0)
  })
})
