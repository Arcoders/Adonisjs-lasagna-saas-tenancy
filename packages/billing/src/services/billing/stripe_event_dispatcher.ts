import type Stripe from 'stripe'
import type BillingService from '../billing_service.js'
import type { Logger } from '@adonisjs/core/logger'
import { DateTime } from 'luxon'
import StripeCustomer from '../../models/satellites/stripe_customer.js'
import StripeSubscription from '../../models/satellites/stripe_subscription.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { redactStripeEvent } from './redact.js'

export interface DispatchContext {
  billing: BillingService
  logger: Logger
}

export interface DispatchResult {
  /** What the handler decided to do — used by the job for logs/audit. */
  outcome: 'synced' | 'stale' | 'unmapped' | 'noop' | 'event_emitted'
  /** Tenant id when resolvable (most events). Null for events that couldn't be matched. */
  tenant_id?: string
}

type Handler = (event: Stripe.Event, ctx: DispatchContext) => Promise<DispatchResult>

/**
 * Routing table from `event.type` to handler. Keep this central — the
 * webhook job is intentionally dumb (decode payload, look up handler,
 * call). All business logic per event-type lives in one of these
 * factories so unit tests can reach them directly.
 *
 * Unmapped event types fall through to a no-op handler that just marks
 * the row `completed` — Stripe sends a lot of event types we don't care
 * about, and treating them as errors would noise up dead-letter alerts.
 */
const HANDLERS: Record<string, Handler> = {
  'checkout.session.completed': handleCheckoutCompleted,

  'customer.subscription.created': handleSubscriptionUpsert,
  'customer.subscription.updated': handleSubscriptionUpsert,
  'customer.subscription.deleted': handleSubscriptionDeleted,
  'customer.subscription.paused': handleSubscriptionPaused,
  'customer.subscription.resumed': handleSubscriptionResumed,
  'customer.subscription.trial_will_end': handleTrialWillEnd,

  'invoice.payment_succeeded': handlePaymentSucceeded,
  'invoice.payment_failed': handlePaymentFailed,

  'customer.deleted': handleCustomerDeleted,
}

export async function dispatchStripeEvent(
  event: Stripe.Event,
  ctx: DispatchContext
): Promise<DispatchResult> {
  const handler = HANDLERS[event.type]
  if (!handler) {
    ctx.logger.debug(redactStripeEvent(event), 'stripe.event.unmapped: no handler — skipping')
    return { outcome: 'noop' }
  }
  return handler(event, ctx)
}

/* --------------------------------------------------------------------- */
/* Handlers                                                              */
/* --------------------------------------------------------------------- */

/**
 * Fires after a successful Checkout Session — for subscription mode the
 * customer object is freshly minted, so we ensure the local mapping
 * exists BEFORE the `subscription.created` webhook arrives. Without this,
 * the subscription handler would fail with `tenant_not_resolvable` on
 * the very first checkout.
 */
async function handleCheckoutCompleted(
  event: Stripe.Event,
  _ctx: DispatchContext
): Promise<DispatchResult> {
  const session = event.data.object as Stripe.Checkout.Session
  if (session.mode !== 'subscription' && session.mode !== 'payment') {
    return { outcome: 'noop' }
  }
  const tenantId = session.client_reference_id
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id
  if (!tenantId || !customerId) return { outcome: 'noop' }

  const existing = await StripeCustomer.find(tenantId)
  if (existing) {
    if (existing.stripeCustomerId !== customerId) {
      // Tenant already has a Stripe customer but checkout used a different
      // one — this is a misconfig (multiple checkouts for the same tenant
      // creating distinct customers). Log loud, don't overwrite.
      _ctx.logger.error(
        {
          tenant_id: tenantId,
          existing_customer: existing.stripeCustomerId,
          incoming_customer: customerId,
        },
        'stripe.checkout.duplicate_customer: tenant already has a different stripe_customer_id'
      )
    }
    return { outcome: 'noop', tenant_id: tenantId }
  }

  const row = new StripeCustomer()
  row.tenantId = tenantId
  row.stripeCustomerId = customerId
  row.currency = null
  row.defaultPaymentMethod = null
  await row.save()
  return { outcome: 'synced', tenant_id: tenantId }
}

async function handleSubscriptionUpsert(
  event: Stripe.Event,
  ctx: DispatchContext
): Promise<DispatchResult> {
  const sub = event.data.object as Stripe.Subscription
  const result = await ctx.billing.syncSubscription(sub, event.created)
  if (!result) return { outcome: 'stale' }
  return { outcome: 'synced', tenant_id: result.tenant_id }
}

async function handleSubscriptionDeleted(
  event: Stripe.Event,
  ctx: DispatchContext
): Promise<DispatchResult> {
  const sub = event.data.object as Stripe.Subscription
  const result = await ctx.billing.syncSubscription(sub, event.created, { downgrade: true })
  if (!result) return { outcome: 'stale' }
  return { outcome: 'synced', tenant_id: result.tenant_id }
}

async function handleSubscriptionPaused(
  event: Stripe.Event,
  ctx: DispatchContext
): Promise<DispatchResult> {
  return handleSubscriptionUpsert(event, ctx)
}

async function handleSubscriptionResumed(
  event: Stripe.Event,
  ctx: DispatchContext
): Promise<DispatchResult> {
  return handleSubscriptionUpsert(event, ctx)
}

async function handleTrialWillEnd(
  event: Stripe.Event,
  _ctx: DispatchContext
): Promise<DispatchResult> {
  const sub = event.data.object as Stripe.Subscription
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
  if (!customerId) return { outcome: 'noop' }
  const customer = await StripeCustomer.query().where('stripeCustomerId', customerId).first()
  if (!customer) return { outcome: 'noop' }

  const trialEnd = sub.trial_end ? DateTime.fromSeconds(sub.trial_end) : null
  const daysLeft = trialEnd ? Math.max(0, Math.ceil(trialEnd.diff(DateTime.utc(), 'days').days)) : 0
  const { default: TrialEnding } = await import('../../events/billing/trial_ending.js')
  await TrialEnding.dispatch({
    tenantId: customer.tenantId,
    stripeSubscriptionId: sub.id,
    daysLeft,
  })
  return { outcome: 'event_emitted', tenant_id: customer.tenantId }
}

async function handlePaymentSucceeded(
  event: Stripe.Event,
  _ctx: DispatchContext
): Promise<DispatchResult> {
  const invoice = event.data.object as Stripe.Invoice
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
  if (!customerId) return { outcome: 'noop' }
  const customer = await StripeCustomer.query().where('stripeCustomerId', customerId).first()
  if (!customer) return { outcome: 'noop' }

  // Recover status from dunning when an outstanding invoice is paid.
  // Without this, a customer who updates their card via the billing
  // portal and triggers a successful retry stays "past_due" in our
  // local mirror until a `customer.subscription.updated` event
  // eventually corrects it — and that event is not guaranteed in
  // every Stripe flow. The host listener for past_due / blocked
  // tenants would keep enforcing dunning behavior on a tenant who
  // just paid.
  const subId = extractInvoiceSubscriptionId(invoice)
  if (subId) {
    const sub = await StripeSubscription.find(subId)
    if (sub && (sub.status === 'past_due' || sub.status === 'unpaid')) {
      const eventAt = DateTime.fromSeconds(event.created)
      // Match syncSubscription's 5s ordering tolerance — events older
      // than (lastEventAt - 5s) are dropped as stale. Avoids reviving
      // an out-of-order payment_succeeded over a later subscription
      // state change.
      if (eventAt >= sub.lastEventAt.minus({ seconds: 5 })) {
        sub.status = 'active'
        sub.lastEventAt = eventAt
        await sub.save()
      }
    }
  }

  const { default: PaymentSucceeded } = await import('../../events/billing/payment_succeeded.js')
  await PaymentSucceeded.dispatch({
    tenantId: customer.tenantId,
    invoiceId: invoice.id ?? null,
    amount: invoice.amount_paid ?? 0,
    currency: invoice.currency ?? 'usd',
  })
  return { outcome: 'event_emitted', tenant_id: customer.tenantId }
}

/**
 * Stripe v18 nests the subscription reference under
 * `parent.subscription_details.subscription`. Older API pinnings expose
 * it on `invoice.subscription` directly. Read both shapes defensively
 * — a single helper keeps the two payment handlers in sync.
 */
export function extractInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const invoiceRaw = invoice as unknown as {
    subscription?: string | { id?: string }
    parent?: { subscription_details?: { subscription?: string | { id?: string } } }
  }
  const ref = invoiceRaw.subscription ?? invoiceRaw.parent?.subscription_details?.subscription
  if (!ref) return null
  return typeof ref === 'string' ? ref : (ref.id ?? null)
}

/**
 * Dunning state machine entry. After `maxAttempts` the row is marked
 * `past_due` (status update through syncSubscription was already done by
 * any preceding subscription.updated, but we defensively mark here too)
 * and a "final" payment_failed event fires so the host's mailers /
 * downgrades hook off `final: true` rather than every single retry.
 */
async function handlePaymentFailed(
  event: Stripe.Event,
  _ctx: DispatchContext
): Promise<DispatchResult> {
  const invoice = event.data.object as Stripe.Invoice
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
  if (!customerId) return { outcome: 'noop' }
  const customer = await StripeCustomer.query().where('stripeCustomerId', customerId).first()
  if (!customer) return { outcome: 'noop' }

  const cfg = getConfig().billing
  const maxAttempts = cfg?.dunning?.maxAttempts ?? 3
  const attempts = invoice.attempt_count ?? 0
  const isFinal = attempts >= maxAttempts

  if (isFinal) {
    const subId = extractInvoiceSubscriptionId(invoice)
    if (subId) {
      const sub = await StripeSubscription.find(subId)
      if (sub && sub.status !== 'past_due' && sub.status !== 'canceled') {
        // Ordering guard symmetric with syncSubscription / handlePaymentSucceeded.
        // Without this, a stale payment_failed delivered after a more
        // recent subscription.updated(active) would silently revert the
        // mirror to past_due. The 5s tolerance matches the rest of the
        // dispatcher.
        const eventAt = DateTime.fromSeconds(event.created)
        if (eventAt >= sub.lastEventAt.minus({ seconds: 5 })) {
          sub.status = 'past_due'
          // Update lastEventAt so the next subscription.updated
          // applies its own ordering guard against THIS event, not a
          // stale earlier one.
          sub.lastEventAt = eventAt
          await sub.save()
        }
      }
    }

    // Apply the configured dunning policy. Only `'downgrade'` is
    // implemented in-package — `'none'` (default) leaves all action to
    // the host's PaymentFailed{final:true} listener. The downgrade is
    // a quota-only side-effect: the local mirror's planName stays on
    // the original plan, so a successful retry's subscription.updated
    // re-resolves it via cfg.products and restores limits. Without
    // that property, recovering customers would silently stay on the
    // defaultPlan.
    if (cfg?.dunning?.action === 'downgrade' && cfg.defaultPlan) {
      try {
        const { QuotaService } = await import('@adonisjs-lasagna/saas-tenancy/services')
        const quotas = new QuotaService()
        await quotas.assignPlan(customer.tenantId, cfg.defaultPlan, { source: 'dunning' })
      } catch (assignErr) {
        // Best-effort: a failed quota write here doesn't roll back the
        // past_due flip or the PaymentFailed event below. The dead-letter
        // path picks up the underlying issue.
        _ctx.logger.error(
          { tenant_id: customer.tenantId, err: (assignErr as Error)?.message },
          'stripe.dunning.downgrade_failed: could not assign defaultPlan'
        )
      }
    }
  }

  const { default: PaymentFailed } = await import('../../events/billing/payment_failed.js')
  await PaymentFailed.dispatch({
    tenantId: customer.tenantId,
    invoiceId: invoice.id ?? null,
    amount: invoice.amount_due ?? 0,
    currency: invoice.currency ?? 'usd',
    attempts,
    final: isFinal,
    nextRetry: invoice.next_payment_attempt
      ? DateTime.fromSeconds(invoice.next_payment_attempt).toISO()
      : null,
  })
  return { outcome: 'event_emitted', tenant_id: customer.tenantId }
}

async function handleCustomerDeleted(
  event: Stripe.Event,
  _ctx: DispatchContext
): Promise<DispatchResult> {
  const stripeCustomer = event.data.object as Stripe.Customer
  const row = await StripeCustomer.query().where('stripeCustomerId', stripeCustomer.id).first()
  if (!row) return { outcome: 'noop' }
  row.deletedAt = DateTime.utc()
  await row.save()
  return { outcome: 'synced', tenant_id: row.tenantId }
}
