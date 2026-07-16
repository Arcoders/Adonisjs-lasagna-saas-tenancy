import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { BillingService, MockStripe, BillingCustomer } from '@adonisjs-lasagna/billing'
import { ADMIN_HEADERS, createInstalledTenant, dropAllTenants } from './_helpers.js'

/**
 * The end-to-end answer to "I installed some satellites, can I add billing
 * later without breaking the rest?", exercised over HTTP. A single tenant
 * drives feature flags, branding, webhooks, audit (written by the lifecycle
 * listener during install), metrics and billing in one session, and we assert
 * each works and none clobbers another. Billing uses MockStripe injected into
 * the BillingService singleton, so no real Stripe account is required.
 */
test.group(
  'e2e — satellites coexistence (flags + branding + webhooks + audit + metrics + billing)',
  (group) => {
    group.setup(async () => {
      await dropAllTenants()
    })
    // Per-test cleanup so rows never bleed between tests: clear the billing
    // mirror (no FK to tenants, so order is free) then drop every tenant.
    group.each.teardown(async () => {
      await db
        .connection('backoffice')
        .rawQuery('DELETE FROM backoffice.billing_customers')
        .catch(() => {})
      await dropAllTenants()
    })

    test('every satellite operates for one tenant in a single lifecycle', async ({
      client,
      assert,
    }) => {
      const { id } = await createInstalledTenant(client)

      // ── feature flags ──
      const ff = await client
        .post('/demo/feature-flags')
        .header('x-tenant-id', id)
        .json({ flag: 'beta_widgets', enabled: true, config: { rollout: 25 } })
      ff.assertStatus(201)

      // ── branding ──
      const br = await client
        .put('/demo/branding')
        .header('x-tenant-id', id)
        .json({ fromName: 'Acme', primaryColor: '#123456' })
      br.assertStatus(200)

      // ── webhooks subscription ──
      const wh = await client
        .post('/demo/webhooks')
        .header('x-tenant-id', id)
        .json({ url: 'https://example.com/hooks', events: ['user.created'] })
      wh.assertStatus(201)

      // ── audit (rows written by the lifecycle listener during install) ──
      const audit = await client.get('/demo/audit').header('x-tenant-id', id)
      audit.assertStatus(200)
      assert.isAbove(audit.body().count, 0, 'lifecycle events wrote audit rows')

      // ── billing: inject MockStripe into the active (Stripe) driver, then checkout ──
      const billing = await app.container.make(BillingService)
      await billing.__setStripeForTests(new MockStripe('whsec_demo_placeholder_secret'))

      const checkout = await client
        .post('/demo/billing/checkout')
        .header('x-tenant-id', id)
        .json({ plan: 'pro' })
      checkout.assertStatus(200)
      assert.match(checkout.body().url, /^https?:\/\//)
      assert.isString(checkout.body().checkoutId)

      const status = await client.get('/demo/billing').header('x-tenant-id', id)
      status.assertStatus(200)
      assert.isTrue(status.body().hasCustomer)
      assert.isNotNull(await BillingCustomer.find(id), 'billing customer mirror persisted')

      // ── metrics endpoint still serves (operational, admin-token-gated) ──
      const metrics = await client.get('/metrics').headers(ADMIN_HEADERS)
      metrics.assertStatus(200)
      assert.match(metrics.text(), /multitenancy_/)

      // ── nothing the earlier satellites wrote was clobbered by adding billing ──
      const flags = await client.get('/demo/feature-flags').header('x-tenant-id', id)
      assert.include(
        flags.body().flags.map((f: any) => f.flag),
        'beta_widgets'
      )
      const branding = await client.get('/demo/branding').header('x-tenant-id', id)
      assert.equal(branding.body().branding.fromName, 'Acme')
      const subs = await client.get('/demo/webhooks').header('x-tenant-id', id)
      assert.lengthOf(subs.body().subscriptions, 1)
    })

    test('billing state is isolated per tenant', async ({ client, assert }) => {
      const a = await createInstalledTenant(client)
      const b = await createInstalledTenant(client)

      const billing = await app.container.make(BillingService)
      await billing.__setStripeForTests(new MockStripe('whsec_demo_placeholder_secret'))

      await client.post('/demo/billing/checkout').header('x-tenant-id', a.id).json({ plan: 'pro' })

      assert.isNotNull(await BillingCustomer.find(a.id))
      assert.isNull(await BillingCustomer.find(b.id))

      const sa = await client.get('/demo/billing').header('x-tenant-id', a.id)
      assert.isTrue(sa.body().hasCustomer)
      const sb = await client.get('/demo/billing').header('x-tenant-id', b.id)
      assert.isFalse(sb.body().hasCustomer)
    })
  }
)
