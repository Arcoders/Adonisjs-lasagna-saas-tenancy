import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe } from '@adonisjs-lasagna/saas-tenancy/testing'
import { StripeCustomer } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
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
    billing.__resetForTests()
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
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const session = await billing.createCheckoutSession(fakeTenant, {
      priceId: 'price_pro_monthly',
      successUrl: 'https://app.example.com/dashboard?ok=1',
      cancelUrl: 'https://app.example.com/pricing',
    })

    assert.isString(session.url)
    assert.isString(session.id)
    assert.match(session.url, /^https:\/\/checkout\.stripe\.test\//)

    // Local mapping was created.
    const cus = await StripeCustomer.find(tenant.id)
    assert.isNotNull(cus, 'ensureCustomer fired during checkout')
    assert.match(cus!.stripeCustomerId, /^cus_/)
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
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    await billing.createCheckoutSession(fakeTenant, {
      priceId: 'price_pro_monthly',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/cancel',
    })
    const firstCustomer = await StripeCustomer.find(tenant.id)

    await billing.createCheckoutSession(fakeTenant, {
      priceId: 'price_team_yearly',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/cancel',
    })
    const rows = await StripeCustomer.query().where('tenant_id', tenant.id)

    assert.lengthOf(rows, 1)
    assert.equal(rows[0].stripeCustomerId, firstCustomer!.stripeCustomerId)
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
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    await assert.rejects(
      () =>
        billing.createBillingPortalSession(fakeTenant, {
          returnUrl: 'https://app.example.com/settings',
        }),
      /Tenant has no Stripe customer/
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
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    await billing.ensureCustomer(fakeTenant)

    const portal = await billing.createBillingPortalSession(fakeTenant, {
      returnUrl: 'https://app.example.com/settings',
    })

    assert.isString(portal.url)
    assert.include(portal.url, encodeURIComponent('https://app.example.com/settings'))
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
    billing.__setStripeForTests(mock)

    await billing.createCheckoutSession(fakeTenant, {
      priceId: 'price_x',
      successUrl: 'https://x',
      cancelUrl: 'https://x',
    })

    assert.lengthOf(captured, 1)
    assert.equal(captured[0].client_reference_id, tenant.id)
  })
})
