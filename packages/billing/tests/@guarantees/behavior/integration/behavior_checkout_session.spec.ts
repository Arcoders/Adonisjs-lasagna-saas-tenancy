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
 * createCheckoutSession & createBillingPortalSession are the two outbound
 * helpers hosts call from their controllers. We test:
 *   - first call auto-creates the Stripe customer
 *   - second call reuses it
 *   - portal requires an existing customer (throws otherwise)
 *   - the session URL + id pair is returned
 */
test.group('Checkout + portal helpers (integration)', (group) => {
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

  test('createCheckoutSession provisions customer + returns url/id', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const session = await billing.createCheckoutSession(fakeTenant, {
      priceId: 'price_pro_monthly',
      successUrl: 'https://app.example.com/dashboard?ok=1',
      cancelUrl: 'https://app.example.com/pricing',
      // Mock auto-derives `prod_pro_monthly` from this priceId, which is
      // not in cfg.products (`prod_pro`). The flag bypasses the allowlist,
      // so this test exercises checkout plumbing, not allowlist validation.
      allowUnknownPrices: true,
    })

    assert.isString(session.url)
    assert.isString(session.id)
    assert.match(session.url, /^https:\/\/checkout\.stripe\.test\//)

    // Local mapping was created.
    const cus = await BillingCustomer.find(tenant.id)
    assert.isNotNull(cus, 'ensureCustomer fired during checkout')
    assert.match(cus!.providerCustomerId, /^cus_/)
  })

  test('two checkout calls reuse the same customer (no duplicates)', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    await billing.createCheckoutSession(fakeTenant, {
      priceId: 'price_pro_monthly',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/cancel',
      allowUnknownPrices: true,
    })
    const firstCustomer = await BillingCustomer.find(tenant.id)

    await billing.createCheckoutSession(fakeTenant, {
      priceId: 'price_team_yearly',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/cancel',
      allowUnknownPrices: true,
    })
    const rows = await BillingCustomer.query().where('tenant_id', tenant.id)

    assert.lengthOf(rows, 1)
    assert.equal(rows[0].providerCustomerId, firstCustomer!.providerCustomerId)
  })

  test('rejects a checkout currency that conflicts with the established customer currency', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    // Customer already established in USD (e.g. from a prior subscription).
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = 'cus_existing'
    cus.currency = 'usd'
    await cus.save()

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    await assert.rejects(
      () =>
        billing.createCheckoutSession(fakeTenant, {
          priceId: 'price_eur',
          successUrl: 'https://app.example.com/ok',
          cancelUrl: 'https://app.example.com/cancel',
          allowUnknownPrices: true,
          currency: 'eur',
        }),
      /does not match the customer's established currency/
    )
  })

  test('allows a checkout whose currency matches the established customer currency', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = 'cus_existing_usd'
    cus.currency = 'usd'
    await cus.save()

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const session = await billing.createCheckoutSession(fakeTenant, {
      priceId: 'price_usd',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/cancel',
      allowUnknownPrices: true,
      currency: 'USD', // case-insensitive match
    })
    assert.isString(session.id)
  })

  test('createBillingPortalSession throws when no customer exists yet', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    await assert.rejects(
      () =>
        billing.createBillingPortalSession(fakeTenant, {
          returnUrl: 'https://app.example.com/settings',
        }),
      /Tenant has no billing customer/
    )
  })

  test('createBillingPortalSession returns a URL once a customer exists', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    await billing.ensureCustomer(fakeTenant)

    const portal = await billing.createBillingPortalSession(fakeTenant, {
      returnUrl: 'https://app.example.com/settings',
    })

    assert.isString(portal.url)
    assert.include(portal.url, encodeURIComponent('https://app.example.com/settings'))
  })

  test('rejects priceId not in cfg.products (default strict allowlist)', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    // Wire the price to a product that's NOT in cfg.products
    // (`prod_starter | prod_pro | prod_team`).
    mock.injectPrice('price_attacker_supplied', 'prod_unknown')
    await billing.__setStripeForTests(mock)

    await assert.rejects(
      () =>
        billing.createCheckoutSession(fakeTenant, {
          priceId: 'price_attacker_supplied',
          successUrl: 'https://app.example.com/ok',
          cancelUrl: 'https://app.example.com/cancel',
        }),
      /not in config\.billing\.products allowlist/
    )
  })

  test('accepts priceId whose product is in cfg.products (fetch-fallback path)', async ({
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
    const mock = new MockStripe('whsec_test_billing_helper')
    // Realistic pattern: one Stripe product, multiple prices (monthly,
    // yearly). cfg.products keys the product, not each price.
    mock.injectPrice('price_pro_monthly_v2', 'prod_pro')
    await billing.__setStripeForTests(mock)

    const session = await billing.createCheckoutSession(fakeTenant, {
      priceId: 'price_pro_monthly_v2',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/cancel',
    })

    assert.isString(session.id)
  })

  test('allowUnknownPrices: true bypasses the allowlist (host validates upstream)', async ({
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
    const mock = new MockStripe('whsec_test_billing_helper')
    mock.injectPrice('price_anything', 'prod_unknown')
    await billing.__setStripeForTests(mock)

    // No throw: the flag opts out of the strict check.
    const session = await billing.createCheckoutSession(fakeTenant, {
      priceId: 'price_anything',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/cancel',
      allowUnknownPrices: true,
    })
    assert.isString(session.id)
  })

  test('client_reference_id defaults to tenant.id (used by checkout.session.completed)', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    // Spy on the underlying mock by capturing the create() call params.
    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    const captured: { client_reference_id: string | null }[] = []
    const original = mock.checkout.sessions.create
    mock.checkout.sessions.create = async (params) => {
      captured.push({ client_reference_id: params.client_reference_id ?? null })
      return original.call(mock.checkout.sessions, params)
    }
    await billing.__setStripeForTests(mock)

    await billing.createCheckoutSession(fakeTenant, {
      priceId: 'price_x',
      successUrl: 'https://x',
      cancelUrl: 'https://x',
      // Mock auto-derives `prod_x`, which isn't in cfg.products. The
      // test is about client_reference_id, not allowlist semantics.
      allowUnknownPrices: true,
    })

    assert.lengthOf(captured, 1)
    assert.equal(captured[0].client_reference_id, tenant.id)
  })
})
