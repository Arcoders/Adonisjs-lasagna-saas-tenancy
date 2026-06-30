import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe } from '@adonisjs-lasagna/billing'
import { BillingCustomer } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from '../../../helpers/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * A5: the user-initiated mutation path must single-flight as tightly as the
 * webhook path. `concurrent_ensure_customer.spec.ts` proves the low-level
 * `ensureCustomer` guard; this spec proves the user-facing entry point —
 * concurrent `createCheckoutSession` calls for one tenant (double-clicked
 * "Subscribe", two tabs) converge on exactly one customer row, no throw.
 *
 * The guards involved (Stripe idempotency key + the `billing_customers`
 * tenant_id PK INSERT-then-adopt-winner) already exist; this test pins them.
 */
test.group('createCheckoutSession — concurrency (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
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

  test('10 concurrent checkouts for one tenant create exactly one customer row', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        billing.createCheckoutSession(fakeTenant, {
          priceId: 'price_pro_monthly',
          successUrl: 'https://app.example.com/ok',
          cancelUrl: 'https://app.example.com/cancel',
          allowUnknownPrices: true,
        })
      )
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    assert.lengthOf(fulfilled, 10, 'every concurrent checkout resolved (no throw under race)')

    const rows = await BillingCustomer.query().where('tenant_id', tenant.id)
    assert.lengthOf(rows, 1, 'exactly one customer row despite the race')

    const customerIds = new Set(rows.map((r) => r.providerCustomerId))
    assert.lengthOf([...customerIds], 1)
  })
})
