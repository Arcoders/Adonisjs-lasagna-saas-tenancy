import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe } from '@adonisjs-lasagna/billing'
import { BillingCustomer } from '@adonisjs-lasagna/billing'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from '../../../helpers/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * `ensureCustomer` must remain idempotent under concurrency. Two paths
 * provide that guarantee in tandem:
 *   - the Stripe `Idempotency-Key: tenant:<id>:create-customer` makes Stripe
 *     dedupe API-side, so even N parallel hits get back the same customer.
 *   - the local UNIQUE constraint on `billing_customers.tenant_id` (the PK)
 *     means the second writer's INSERT loses; we re-SELECT and return the winner.
 *
 * This spec runs N parallel ensureCustomer calls on the same tenant and
 * asserts: 1 Stripe customer created, 1 local row, no exceptions thrown.
 */
test.group('BillingService.ensureCustomer — concurrency (integration)', (group) => {
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

  test('50 parallel calls produce exactly one customer row', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
    } as unknown as TenantModelContract

    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    await billing.__setStripeForTests(mock)

    const calls = await Promise.allSettled(
      Array.from({ length: 50 }, () => billing.ensureCustomer(fakeTenant))
    )

    const fulfilled = calls.filter((c) => c.status === 'fulfilled')
    assert.lengthOf(fulfilled, 50, 'every call resolved (no throw under race)')

    // Every fulfilled value points to the same local row.
    const customerIds = new Set(
      fulfilled.map(
        (c) =>
          (c as PromiseFulfilledResult<{ providerCustomerId: string }>).value.providerCustomerId
      )
    )
    assert.lengthOf([...customerIds], 1, 'all callers returned the same stripe_customer_id')

    const rows = await BillingCustomer.query().where('tenant_id', tenant.id)
    assert.lengthOf(rows, 1, 'exactly one DB row')

    // The Stripe-side idempotency key was hit on the second through Nth
    // calls. The cache key matches what BillingService passes.
    assert.isTrue(
      mock.idempotencyHits(`tenant:${tenant.id}:create-customer`),
      'Stripe-side idempotency-key cache used'
    )
  })

  test('a second call after persistence returns the existing row without hitting Stripe', async ({
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
    await billing.__setStripeForTests(mock)

    const first = await billing.ensureCustomer(fakeTenant)
    const beforeIdempotencyHit = mock.idempotencyHits(`tenant:${tenant.id}:create-customer`)

    // Replace the mock with a fresh one to prove the second call did NOT
    // hit Stripe at all (it short-circuits on the local row lookup).
    const freshMock = new MockStripe('whsec_test_billing_helper')
    await billing.__setStripeForTests(freshMock)

    const second = await billing.ensureCustomer(fakeTenant)

    assert.equal(second.providerCustomerId, first.providerCustomerId)
    assert.isTrue(beforeIdempotencyHit, 'first call reached Stripe')
    assert.isFalse(
      freshMock.idempotencyHits(`tenant:${tenant.id}:create-customer`),
      'second call short-circuits — Stripe never hit'
    )
  })
})
