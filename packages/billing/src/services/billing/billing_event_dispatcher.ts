import type BillingService from '../billing_service.js'
import type { Logger } from '@adonisjs/core/logger'
import { DateTime } from 'luxon'
import BillingCustomer from '../../models/satellites/billing_customer.js'
import BillingSubscription from '../../models/satellites/billing_subscription.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { BillingWebhookEvent } from '../../contracts/types.js'
import { redactBillingEvent } from './redact.js'

export interface DispatchContext {
  billing: BillingService
  logger: Logger
}

export interface DispatchResult {
  /** What the handler decided to do — used by the job for logs/audit. */
  outcome: 'synced' | 'stale' | 'unmapped' | 'noop' | 'event_emitted'
  /** Tenant id when resolvable. Null for events that couldn't be matched. */
  tenant_id?: string
}

type EventOf<T extends BillingWebhookEvent['type']> = Extract<BillingWebhookEvent, { type: T }>

/**
 * Route a neutral `BillingWebhookEvent` to its handler. The webhook job is
 * intentionally dumb (verify, decode, look up, call); all per-event business
 * logic lives here so unit tests can reach the handlers directly.
 *
 * Unmapped types fall through to a no-op so providers' chatty event streams
 * don't noise up dead-letter alerts.
 */
export async function dispatchBillingEvent(
  event: BillingWebhookEvent,
  ctx: DispatchContext
): Promise<DispatchResult> {
  switch (event.type) {
    case 'checkout.completed':
      return handleCheckoutCompleted(event, ctx)
    case 'subscription.upsert':
      return handleSubscriptionUpsert(event, ctx)
    case 'subscription.deleted':
      return handleSubscriptionDeleted(event, ctx)
    case 'subscription.trial_will_end':
      return handleTrialWillEnd(event, ctx)
    case 'payment.succeeded':
      return handlePaymentSucceeded(event, ctx)
    case 'payment.failed':
      return handlePaymentFailed(event, ctx)
    case 'customer.deleted':
      return handleCustomerDeleted(event, ctx)
    default:
      ctx.logger.debug(redactBillingEvent(event), 'billing.event.unmapped: no handler — skipping')
      return { outcome: 'noop' }
  }
}

/* --------------------------------------------------------------------- */
/* Handlers                                                              */
/* --------------------------------------------------------------------- */

/**
 * Fires after a successful checkout — ensures the local customer mapping exists
 * BEFORE the `subscription.upsert` webhook arrives, so the subscription handler
 * doesn't fail with `tenant_not_resolvable` on the very first checkout.
 */
async function handleCheckoutCompleted(
  event: EventOf<'checkout.completed'>,
  ctx: DispatchContext
): Promise<DispatchResult> {
  const { mode, clientReferenceId: tenantId, customerId } = event.data
  if (mode !== 'subscription' && mode !== 'payment') return { outcome: 'noop' }
  if (!tenantId || !customerId) return { outcome: 'noop' }

  const existing = await BillingCustomer.find(tenantId)
  if (existing) {
    if (existing.providerCustomerId !== customerId) {
      ctx.logger.error(
        {
          tenant_id: tenantId,
          existing_customer: existing.providerCustomerId,
          incoming_customer: customerId,
        },
        'billing.checkout.duplicate_customer: tenant already has a different provider customer id'
      )
    }
    return { outcome: 'noop', tenant_id: tenantId }
  }

  const row = new BillingCustomer()
  row.tenantId = tenantId
  row.provider = event.provider
  row.providerCustomerId = customerId
  row.currency = null
  row.defaultPaymentMethod = null
  await row.save()
  return { outcome: 'synced', tenant_id: tenantId }
}

async function handleSubscriptionUpsert(
  event: EventOf<'subscription.upsert'>,
  ctx: DispatchContext
): Promise<DispatchResult> {
  const result = await ctx.billing.syncSubscription(event.data, event.createdAt)
  if (!result) return { outcome: 'stale' }
  return { outcome: 'synced', tenant_id: result.tenant_id }
}

async function handleSubscriptionDeleted(
  event: EventOf<'subscription.deleted'>,
  ctx: DispatchContext
): Promise<DispatchResult> {
  const result = await ctx.billing.syncSubscription(event.data, event.createdAt, {
    downgrade: true,
  })
  if (!result) return { outcome: 'stale' }
  return { outcome: 'synced', tenant_id: result.tenant_id }
}

async function handleTrialWillEnd(
  event: EventOf<'subscription.trial_will_end'>,
  _ctx: DispatchContext
): Promise<DispatchResult> {
  const sub = event.data
  if (!sub.customerId) return { outcome: 'noop' }
  const customer = await BillingCustomer.query().where('providerCustomerId', sub.customerId).first()
  if (!customer) return { outcome: 'noop' }

  const trialEnd = sub.trialEnd ? DateTime.fromSeconds(sub.trialEnd) : null
  const daysLeft = trialEnd ? Math.max(0, Math.ceil(trialEnd.diff(DateTime.utc(), 'days').days)) : 0
  const { default: TrialEnding } = await import('../../events/billing/trial_ending.js')
  await TrialEnding.dispatch({
    tenantId: customer.tenantId,
    subscriptionId: sub.providerSubscriptionId,
    daysLeft,
  })
  return { outcome: 'event_emitted', tenant_id: customer.tenantId }
}

async function handlePaymentSucceeded(
  event: EventOf<'payment.succeeded'>,
  _ctx: DispatchContext
): Promise<DispatchResult> {
  const invoice = event.data
  if (!invoice.customerId) return { outcome: 'noop' }
  const customer = await BillingCustomer.query()
    .where('providerCustomerId', invoice.customerId)
    .first()
  if (!customer) return { outcome: 'noop' }

  // Recover status from dunning when an outstanding invoice is paid. Without
  // this, a customer who updates their card and triggers a successful retry
  // stays "past_due" locally until a later subscription event corrects it.
  if (invoice.subscriptionId) {
    const sub = await BillingSubscription.find(invoice.subscriptionId)
    if (sub && (sub.status === 'past_due' || sub.status === 'unpaid')) {
      const eventAt = DateTime.fromSeconds(event.createdAt)
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
    invoiceId: invoice.id,
    amount: invoice.amountPaid,
    currency: invoice.currency,
  })
  return { outcome: 'event_emitted', tenant_id: customer.tenantId }
}

/**
 * Dunning entry. After `maxAttempts` the row is marked `past_due` and a "final"
 * payment_failed event fires so the host's mailers / downgrades hook off
 * `final: true` rather than every retry.
 */
async function handlePaymentFailed(
  event: EventOf<'payment.failed'>,
  ctx: DispatchContext
): Promise<DispatchResult> {
  const invoice = event.data
  if (!invoice.customerId) return { outcome: 'noop' }
  const customer = await BillingCustomer.query()
    .where('providerCustomerId', invoice.customerId)
    .first()
  if (!customer) return { outcome: 'noop' }

  const cfg = getConfig().billing
  const maxAttempts = cfg?.dunning?.maxAttempts ?? 3
  const attempts = invoice.attemptCount
  const isFinal = attempts >= maxAttempts

  if (isFinal) {
    if (invoice.subscriptionId) {
      const sub = await BillingSubscription.find(invoice.subscriptionId)
      if (sub && sub.status !== 'past_due' && sub.status !== 'canceled') {
        const eventAt = DateTime.fromSeconds(event.createdAt)
        if (eventAt >= sub.lastEventAt.minus({ seconds: 5 })) {
          sub.status = 'past_due'
          sub.lastEventAt = eventAt
          await sub.save()
        }
      }
    }

    if (cfg?.dunning?.action === 'downgrade' && cfg.defaultPlan) {
      try {
        const { QuotaService } = await import('@adonisjs-lasagna/saas-tenancy/services')
        const quotas = new QuotaService()
        await quotas.assignPlan(customer.tenantId, cfg.defaultPlan, { source: 'dunning' })
      } catch (assignErr) {
        ctx.logger.error(
          { tenant_id: customer.tenantId, err: (assignErr as Error)?.message },
          'billing.dunning.downgrade_failed: could not assign defaultPlan'
        )
      }
    }
  }

  const { default: PaymentFailed } = await import('../../events/billing/payment_failed.js')
  await PaymentFailed.dispatch({
    tenantId: customer.tenantId,
    invoiceId: invoice.id,
    amount: invoice.amountDue,
    currency: invoice.currency,
    attempts,
    final: isFinal,
    nextRetry: invoice.nextPaymentAttempt
      ? DateTime.fromSeconds(invoice.nextPaymentAttempt).toISO()
      : null,
  })
  return { outcome: 'event_emitted', tenant_id: customer.tenantId }
}

async function handleCustomerDeleted(
  event: EventOf<'customer.deleted'>,
  _ctx: DispatchContext
): Promise<DispatchResult> {
  const row = await BillingCustomer.query()
    .where('providerCustomerId', event.data.providerCustomerId)
    .first()
  if (!row) return { outcome: 'noop' }
  row.deletedAt = DateTime.utc()
  await row.save()
  return { outcome: 'synced', tenant_id: row.tenantId ?? undefined }
}
