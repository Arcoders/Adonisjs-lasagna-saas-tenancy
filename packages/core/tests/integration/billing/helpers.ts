import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '../../helpers/config.js'
import type Stripe from 'stripe'

export interface BillingTestSetup {
  defaultPlan: string
  productMappings?: Record<string, string>
  notifyOnQuotaExceeded?: boolean
  usageMapping?: Record<string, { meterEventName: string }>
}

/**
 * Wire up `config.billing` + `config.plans` for an integration test. Uses
 * fake API/webhook secrets — tests inject MockStripe via
 * `BillingService.__setStripeForTests`, so the SDK is never instantiated
 * with these.
 */
export function setupBillingConfig(opts: BillingTestSetup = { defaultPlan: 'starter' }): void {
  setConfig({
    ...testConfig,
    plans: {
      defaultPlan: opts.defaultPlan,
      definitions: {
        starter: { limits: { apiRequests: 100 } },
        pro: { limits: { apiRequests: 10_000 } },
        team: { limits: { apiRequests: 50_000 } },
      },
      storage: 'tenant_plans',
    },
    billing: {
      driver: 'stripe',
      stripe: {
        apiKey: 'sk_test_billing_test_helper',
        webhookSecret: 'whsec_test_billing_helper',
      },
      products: opts.productMappings ?? {
        prod_starter: 'starter',
        prod_pro: 'pro',
        prod_team: 'team',
      },
      defaultPlan: opts.defaultPlan,
      notifyOnQuotaExceeded: opts.notifyOnQuotaExceeded,
      usageMapping: opts.usageMapping,
    },
  } as never)
}

/**
 * Build a Stripe.Subscription test fixture matching what an event payload
 * would carry. Defaults to `active` / `prod_pro` / 30d period.
 */
export function buildSubscription(
  overrides: Partial<{
    id: string
    customer: string
    status: Stripe.Subscription.Status
    productId: string
    priceId: string
    canceledAt: number | null
    cancelAtPeriodEnd: boolean
    trialEnd: number | null
  }> = {}
): Stripe.Subscription {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: overrides.id ?? `sub_test_${randomUUID().slice(0, 8)}`,
    object: 'subscription',
    customer: overrides.customer ?? `cus_test_${randomUUID().slice(0, 8)}`,
    status: overrides.status ?? 'active',
    items: {
      data: [
        {
          price: {
            id: overrides.priceId ?? 'price_pro_monthly',
            product: overrides.productId ?? 'prod_pro',
          } as Stripe.Price,
          current_period_start: now,
          current_period_end: now + 30 * 86_400,
        } as never,
      ],
      object: 'list',
      has_more: false,
      url: '',
    } as Stripe.ApiList<Stripe.SubscriptionItem>,
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    canceled_at: overrides.canceledAt ?? null,
    trial_end: overrides.trialEnd ?? null,
    metadata: {},
  } as unknown as Stripe.Subscription
}

/**
 * Wrap a subscription payload as a Stripe.Event.
 */
export function buildEvent(
  type: string,
  obj: unknown,
  overrides: Partial<{ id: string; created: number }> = {}
): Stripe.Event {
  return {
    id: overrides.id ?? `evt_test_${randomUUID().slice(0, 8)}`,
    object: 'event',
    type,
    created: overrides.created ?? Math.floor(Date.now() / 1000),
    api_version: '2025-08-27.basil',
    data: { object: obj },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  } as unknown as Stripe.Event
}

/**
 * Hydrate a `@boringnode/queue` Job instance with a payload + minimal
 * context so we can drive its `execute()` / `failed()` lifecycle inline
 * from a spec (without spinning up a real worker).
 *
 * `Job#payload` is a getter — direct assignment is rejected at runtime
 * with `Cannot set property payload of #<Job> which has only a getter`.
 * The supported entry-point is the `$hydrate(payload, context, signal?)`
 * method, which is what the worker calls in production.
 */
export function hydrateJob<P>(
  job: object,
  payload: P,
  overrides: Partial<{ jobId: string; queue: string; attempt: number }> = {}
): void {
  ;(job as unknown as { $hydrate: (p: P, ctx: object, signal?: AbortSignal) => void }).$hydrate(
    payload,
    {
      jobId: overrides.jobId ?? `job_${randomUUID().slice(0, 8)}`,
      name: (job as { constructor: { name: string } }).constructor.name,
      attempt: overrides.attempt ?? 1,
      queue: overrides.queue ?? 'billing-events',
      priority: 0,
      acquiredAt: new Date(),
      stalledCount: 0,
    }
  )
}

/**
 * Truncate every billing table — call this from `group.each.teardown` to
 * keep specs isolated. Order matters because of FKs.
 */
export async function clearBillingTables(): Promise<void> {
  const conn = db.connection('backoffice')
  await conn.rawQuery('DELETE FROM backoffice.stripe_meter_events')
  await conn.rawQuery('DELETE FROM backoffice.stripe_processed_events')
  await conn.rawQuery('DELETE FROM backoffice.stripe_subscriptions')
  await conn.rawQuery('DELETE FROM backoffice.stripe_customers')
  await conn.rawQuery('DELETE FROM backoffice.tenant_plans')
}
