import { test } from '@japa/runner'
import { dispatchBillingEvent } from '../../../../src/services/billing/billing_event_dispatcher.js'
import type { BillingWebhookEvent, Subscription } from '../../../../src/contracts/types.js'
import type BillingService from '../../../../src/services/billing_service.js'

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Parameters<typeof dispatchBillingEvent>[1]['logger']

function neutralSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    providerSubscriptionId: 'sub_1',
    customerId: 'cus_1',
    status: 'active',
    currentPeriodStart: 1_700_000_000,
    currentPeriodEnd: 1_702_592_000,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    canceledAt: null,
    trialEnd: null,
    productId: 'prod_pro',
    priceId: 'price_pro',
    raw: {},
    ...overrides,
  }
}

function subscriptionEvent(
  type: 'subscription.upsert' | 'subscription.deleted'
): BillingWebhookEvent {
  return {
    id: 'evt_1',
    createdAt: 1_700_000_500,
    provider: 'stripe',
    nativeType: 'customer.subscription.updated',
    type,
    data: neutralSub(),
  }
}

test.group('dispatchBillingEvent — routing', () => {
  test('unmapped events resolve to noop without touching billing/db', async ({ assert }) => {
    const billingSpy = new Proxy(
      {},
      {
        get() {
          throw new Error('billing must not be touched for an unmapped event')
        },
      }
    ) as unknown as BillingService

    const event: BillingWebhookEvent = {
      id: 'evt_x',
      createdAt: 1,
      provider: 'stripe',
      nativeType: 'charge.refunded',
      type: 'unknown',
      data: {},
    }
    const result = await dispatchBillingEvent(event, { billing: billingSpy, logger: noopLogger })
    assert.deepEqual(result, { outcome: 'noop' })
  })

  test('subscription.upsert delegates the neutral subscription to syncSubscription', async ({
    assert,
  }) => {
    let received: { sub: Subscription; created: number; opts?: unknown } | null = null
    const billing = {
      async syncSubscription(sub: Subscription, created: number, opts?: unknown) {
        received = { sub, created, opts }
        return { tenant_id: 'tenant-1', plan: 'pro', previousPlan: null }
      },
    } as unknown as BillingService

    const result = await dispatchBillingEvent(subscriptionEvent('subscription.upsert'), {
      billing,
      logger: noopLogger,
    })
    assert.deepEqual(result, { outcome: 'synced', tenant_id: 'tenant-1' })
    assert.equal(received!.sub.providerSubscriptionId, 'sub_1')
    assert.equal(received!.created, 1_700_000_500)
    assert.isUndefined(received!.opts)
  })

  test('subscription.deleted passes the downgrade flag', async ({ assert }) => {
    let opts: any = null
    const billing = {
      async syncSubscription(_sub: Subscription, _created: number, o?: unknown) {
        opts = o
        return { tenant_id: 't', plan: 'free', previousPlan: 'pro' }
      },
    } as unknown as BillingService

    await dispatchBillingEvent(subscriptionEvent('subscription.deleted'), {
      billing,
      logger: noopLogger,
    })
    assert.deepEqual(opts, { downgrade: true })
  })

  test('a stale subscription event (sync returns null) is reported as stale', async ({
    assert,
  }) => {
    const billing = {
      async syncSubscription() {
        return null
      },
    } as unknown as BillingService
    const result = await dispatchBillingEvent(subscriptionEvent('subscription.upsert'), {
      billing,
      logger: noopLogger,
    })
    assert.deepEqual(result, { outcome: 'stale' })
  })
})
