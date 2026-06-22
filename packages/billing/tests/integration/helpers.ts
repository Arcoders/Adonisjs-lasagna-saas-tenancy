import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type Stripe from 'stripe'
import type { Subscription, SubscriptionStatus } from '@adonisjs-lasagna/billing'

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
 * Build a neutral `Subscription` (the shape `BillingService.syncSubscription`
 * now consumes, after the multi-provider refactor). The override keys mirror
 * `buildSubscription` for an easy swap: `customer` → `customerId`,
 * `id` → `providerSubscriptionId`. Defaults to `active` / `prod_pro` / 30d.
 */
export function buildNeutralSubscription(
  overrides: Partial<{
    id: string
    customer: string
    status: SubscriptionStatus
    productId: string
    priceId: string
    canceledAt: number | null
    cancelAtPeriodEnd: boolean
    trialEnd: number | null
  }> = {}
): Subscription {
  const now = Math.floor(Date.now() / 1000)
  return {
    providerSubscriptionId: overrides.id ?? `sub_test_${randomUUID().slice(0, 8)}`,
    customerId: overrides.customer ?? `cus_test_${randomUUID().slice(0, 8)}`,
    status: overrides.status ?? 'active',
    currentPeriodStart: now,
    currentPeriodEnd: now + 30 * 86_400,
    cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
    cancelAt: null,
    canceledAt: overrides.canceledAt ?? null,
    trialEnd: overrides.trialEnd ?? null,
    productId: overrides.productId ?? 'prod_pro',
    priceId: overrides.priceId ?? 'price_pro_monthly',
    raw: {},
  }
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
 * The neutral subscription statuses (kept in sync with `SUBSCRIPTION_STATUSES`
 * in `src/contracts/types.ts`). Inlined here rather than importing the runtime
 * guard, which is not part of the package's public barrel — keeping it off the
 * public surface avoids a changeset just to assert in a test.
 */
const KNOWN_SUBSCRIPTION_STATUSES: readonly string[] = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]

/**
 * Assert a row yielded by a driver's `listSubscriptions()` is a well-formed
 * neutral `Subscription`. Used by the provider real-API reconciliation smokes to
 * prove the live `/subscriptions` endpoint + pagination + `toSubscription`
 * mapping produce the neutral shape (which the stubbed `*_driver.spec.ts` can't).
 * Throws (failing the test) on any drift rather than relying on japa's `assert`.
 */
export function assertNeutralSubscription(sub: Subscription): void {
  const dump = JSON.stringify(sub)
  if (typeof sub.providerSubscriptionId !== 'string' || sub.providerSubscriptionId.length === 0) {
    throw new Error(`listSubscriptions yielded a row without a providerSubscriptionId: ${dump}`)
  }
  if (typeof sub.customerId !== 'string') {
    throw new Error(`listSubscriptions row missing a string customerId: ${dump}`)
  }
  if (!KNOWN_SUBSCRIPTION_STATUSES.includes(sub.status)) {
    throw new Error(`listSubscriptions row mapped to a non-neutral status "${sub.status}": ${dump}`)
  }
  if (typeof sub.currentPeriodStart !== 'number' || typeof sub.currentPeriodEnd !== 'number') {
    throw new Error(`listSubscriptions row has non-numeric period bounds: ${dump}`)
  }
}

/**
 * Truncate every billing table — call this from `group.each.teardown` to
 * keep specs isolated. Order matters because of FKs.
 */
export async function clearBillingTables(): Promise<void> {
  const conn = db.connection('backoffice')
  await conn.rawQuery('DELETE FROM backoffice.billing_usage_events')
  await conn.rawQuery('DELETE FROM backoffice.billing_processed_events')
  await conn.rawQuery('DELETE FROM backoffice.billing_invoice_snapshots')
  await conn.rawQuery('DELETE FROM backoffice.billing_subscriptions')
  await conn.rawQuery('DELETE FROM backoffice.billing_customers')
  await conn.rawQuery('DELETE FROM backoffice.tenant_plans')
}
