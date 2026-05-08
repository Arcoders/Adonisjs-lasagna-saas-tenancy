import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe } from '@adonisjs-lasagna/saas-tenancy/testing'
import { StripeCustomer, StripeSubscription } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { dispatchStripeEvent } from '../../../src/services/billing/stripe_event_dispatcher.js'
import { setupBillingConfig, buildEvent, buildSubscription, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

/**
 * Capture every log statement during a full webhook flow and confirm
 * NONE of them carry PII. The strip-list approach in `redact.ts` guards
 * the input shape; this spec is the end-to-end check that nothing else
 * leaks through (e.g. a future log line that interpolates raw event
 * data).
 *
 * The check is structural: we look for fields that should never appear
 * in a billing log. Any future regression that adds `email`, `last4`,
 * etc. will trip this test.
 */
test.group('PII redaction (integration)', (group) => {
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

  test('full sync flow leaks no PII into structured logs', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    // Pre-existing sub so the ordering guard's stale-event branch is
    // also exercised (it logs `stripe.event.stale`).
    const subId = `sub_${randomUUID().slice(0, 8)}`
    const stale = new StripeSubscription()
    stale.stripeSubscriptionId = subId
    stale.tenantId = tenant.id
    stale.status = 'active'
    stale.currentPeriodStart = DateTime.utc().minus({ days: 1 })
    stale.currentPeriodEnd = DateTime.utc().plus({ days: 29 })
    stale.cancelAtPeriodEnd = false
    stale.cancelAt = null
    stale.canceledAt = null
    stale.trialEnd = null
    stale.planName = 'pro'
    stale.lastEventAt = DateTime.utc()
    stale.raw = {}
    await stale.save()

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    // Capture every structured log entry during the dispatch.
    const captured: unknown[] = []
    const realChild = logger.child.bind(logger)
    const childCalls: unknown[] = []
    logger.child = ((bindings: object) => {
      childCalls.push(bindings)
      return realChild(bindings)
    }) as typeof logger.child

    // Patch each level on the underlying pino instance via wrapping.
    const levels = ['info', 'warn', 'error', 'debug'] as const
    const originals: Partial<Record<(typeof levels)[number], (...args: unknown[]) => void>> = {}
    for (const lvl of levels) {
      originals[lvl] = (logger as unknown as Record<string, (...args: unknown[]) => void>)[lvl]
      ;(logger as unknown as Record<string, (...args: unknown[]) => void>)[lvl] = (
        ...args: unknown[]
      ) => {
        captured.push({ level: lvl, args })
      }
    }

    try {
      // Hostile event with PII inside the subscription object — should
      // be reduced to safe fields by `redactStripeEvent` before any log.
      const sub = buildSubscription({
        id: subId,
        customer: stripeCustomerId,
        productId: 'prod_pro',
      })
      const hostile = buildEvent('customer.subscription.updated', {
        ...sub,
        // PII landmines:
        billing_details: { email: 'user@example.com', name: 'Jane Doe', phone: '+1-555' },
        payment_method: { card: { last4: '4242' } },
        receipt_number: 'shhh-receipt',
      })
      // Make the event_at older than last_event_at to also exercise the
      // stale-event log branch.
      hostile.created = Math.floor(stale.lastEventAt.toSeconds()) - 30

      await dispatchStripeEvent(hostile, { billing, logger })

      const blob = JSON.stringify(captured)
      const FORBIDDEN = [
        'user@example.com',
        'Jane Doe',
        '+1-555',
        '4242',
        'shhh-receipt',
        'billing_details',
        'payment_method',
      ]
      for (const needle of FORBIDDEN) {
        assert.notInclude(blob, needle, `log leaked "${needle}"`)
      }
      // Sanity: at least one log fired (otherwise the assertions above
      // are vacuous).
      assert.isAbove(captured.length, 0, 'at least one log captured')
    } finally {
      for (const lvl of levels) {
        if (originals[lvl]) {
          ;(logger as unknown as Record<string, (...args: unknown[]) => void>)[lvl] = originals[lvl]!
        }
      }
      logger.child = realChild
      void childCalls
    }
  })
})
