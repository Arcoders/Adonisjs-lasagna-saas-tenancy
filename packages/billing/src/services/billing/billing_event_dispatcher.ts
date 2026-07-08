import type BillingService from '../billing_service.js'
import type { Logger } from '@adonisjs/core/logger'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import BillingCustomer from '../../models/satellites/billing_customer.js'
import BillingSubscription from '../../models/satellites/billing_subscription.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { BillingWebhookEvent, Invoice } from '../../contracts/types.js'
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
  // backoffice-scope-exempt: a provider webhook resolves the OWNING tenant by its provider customer id (no tenant_id exists to scope by until this returns).
  const customer = await BillingCustomer.query().where('providerCustomerId', sub.customerId).first()
  if (!customer) return { outcome: 'noop' }

  // Dedupe against the `tenant:billing:sweep` fallback: whichever fires first
  // stamps `trialEndingNotifiedAt`, the other no-ops, so each subscription is
  // notified exactly once across providers.
  const row = await BillingSubscription.find(sub.providerSubscriptionId)
  if (row?.trialEndingNotifiedAt) return { outcome: 'noop', tenant_id: customer.tenantId }

  await dispatchTrialEnding(customer.tenantId, sub.providerSubscriptionId, sub.trialEnd)
  if (row) {
    row.trialEndingNotifiedAt = DateTime.utc()
    await row.save()
  }
  return { outcome: 'event_emitted', tenant_id: customer.tenantId }
}

/**
 * Compute days-left and dispatch `TrialEnding`. Shared by the native Stripe
 * `trial_will_end` handler and the provider-agnostic `tenant:billing:sweep`
 * fallback (Paddle / Lemon Squeezy have no native trial-ending webhook).
 */
export async function dispatchTrialEnding(
  tenantId: string,
  subscriptionId: string,
  trialEndSeconds: number | null
): Promise<void> {
  const trialEnd = trialEndSeconds ? DateTime.fromSeconds(trialEndSeconds) : null
  const daysLeft = trialEnd ? Math.max(0, Math.ceil(trialEnd.diff(DateTime.utc(), 'days').days)) : 0
  const { default: TrialEnding } = await import('../../events/billing/trial_ending.js')
  await TrialEnding.dispatch({ tenantId, subscriptionId, daysLeft })
}

async function handlePaymentSucceeded(
  event: EventOf<'payment.succeeded'>,
  ctx: DispatchContext
): Promise<DispatchResult> {
  const invoice = event.data
  if (!invoice.customerId) return { outcome: 'noop' }
  // backoffice-scope-exempt: a provider webhook resolves the OWNING tenant by its provider customer id (no tenant_id exists to scope by until this returns).
  const customer = await BillingCustomer.query()
    .where('providerCustomerId', invoice.customerId)
    .first()
  if (!customer) return { outcome: 'noop' }

  // Recover status from dunning when an outstanding invoice is paid, and clear
  // the dunning counter so a future failure streak starts fresh. Without the
  // status recovery, a customer who updates their card and triggers a
  // successful retry stays "past_due" locally until a later subscription event
  // corrects it. The counter reset also covers the active-with-prior-failures
  // case (attempts accumulated but not yet final), so a success doesn't leave a
  // stale count that prematurely escalates the next failure.
  if (invoice.subscriptionId) {
    const sub = await BillingSubscription.find(invoice.subscriptionId)
    if (sub) {
      const eventAt = DateTime.fromSeconds(event.createdAt)
      if (eventAt >= sub.lastEventAt.minus({ seconds: 5 })) {
        if (sub.status === 'past_due' || sub.status === 'unpaid') {
          sub.status = 'active'
          sub.lastEventAt = eventAt
        }
        sub.dunningAttempts = 0
        sub.dunningLastEventId = null
        sub.dunningDowngradeAt = null
        if (sub.$isDirty) await sub.save()
      }
    }
  }

  // Fiscal opt-in: snapshot the invoice for reporting/reconciliation. Best
  // effort — a snapshot failure must never dead-letter a successful payment.
  if (getConfig().billing?.fiscal?.enabled && invoice.id) {
    await snapshotInvoice(event.provider, customer.tenantId, invoice, event.createdAt, ctx.logger)
  }

  const { default: PaymentSucceeded } = await import('../../events/billing/payment_succeeded.js')
  await PaymentSucceeded.dispatch({
    tenantId: customer.tenantId,
    invoiceId: invoice.id,
    amount: invoice.amountPaid,
    currency: invoice.currency,
    tax: invoice.tax ?? null,
    total: invoice.total ?? null,
  })
  return { outcome: 'event_emitted', tenant_id: customer.tenantId }
}

/**
 * Append (or no-op) a provider invoice into the fiscal read model. Idempotent on
 * `(provider, provider_invoice_id)` via a unique-violation catch, so a webhook
 * redelivery doesn't duplicate. Never throws — the snapshot is reporting-only.
 */
async function snapshotInvoice(
  provider: string,
  tenantId: string,
  invoice: Invoice,
  eventCreated: number,
  logger: Logger
): Promise<void> {
  try {
    const { default: BillingInvoiceSnapshot } =
      await import('../../models/satellites/billing_invoice_snapshot.js')
    const total = invoice.total ?? invoice.amountPaid
    const tax = invoice.tax ?? 0
    const subtotal = invoice.subtotal ?? total - tax
    await BillingInvoiceSnapshot.create({
      id: randomUUID(),
      provider,
      providerInvoiceId: invoice.id!,
      tenantId,
      currency: invoice.currency,
      subtotalCents: subtotal,
      taxCents: tax,
      totalCents: total,
      status: 'paid',
      pdfUrl: null,
      issuedAt: DateTime.fromSeconds(eventCreated),
    })
  } catch (err) {
    // A duplicate (redelivery) trips the unique constraint — expected, ignore.
    // Anything else is logged but not rethrown: the payment still succeeded.
    logger.debug(
      { provider, provider_invoice_id: invoice.id, err: (err as Error)?.message },
      'billing.invoice_snapshot.skipped'
    )
  }
}

/**
 * Dunning entry. Escalation is driven by a provider-independent attempt counter
 * persisted on the subscription, so dunning works even for providers that
 * under-report attempts (Lemon Squeezy sends none, Paddle approximates). We
 * escalate on `max(provider.attemptCount, localCounter)`: Stripe's real
 * `attempt_count` is never lost, and providers that report 0 still reach
 * `maxAttempts` via the local count.
 *
 * Idempotency: the counter is guarded by `dunningLastEventId` so a job retry of
 * the same event can't double-count. Ordering: a stale (out-of-order) failure
 * neither increments nor escalates. On `maxAttempts` the row is marked
 * `past_due` and a "final" `PaymentFailed` fires so the host's mailers /
 * downgrades hook off `final: true` rather than every retry. The configured
 * downgrade is applied immediately when `gracePeriodDays` is 0, or scheduled via
 * `dunningDowngradeAt` (applied by `tenant:billing:sweep`) when a grace period
 * is set.
 */
async function handlePaymentFailed(
  event: EventOf<'payment.failed'>,
  ctx: DispatchContext
): Promise<DispatchResult> {
  const invoice = event.data
  if (!invoice.customerId) return { outcome: 'noop' }
  // backoffice-scope-exempt: a provider webhook resolves the OWNING tenant by its provider customer id (no tenant_id exists to scope by until this returns).
  const customer = await BillingCustomer.query()
    .where('providerCustomerId', invoice.customerId)
    .first()
  if (!customer) return { outcome: 'noop' }

  const cfg = getConfig().billing
  const maxAttempts = cfg?.dunning?.maxAttempts ?? 3
  const gracePeriodDays = cfg?.dunning?.gracePeriodDays ?? 0
  const eventAt = DateTime.fromSeconds(event.createdAt)

  const sub = invoice.subscriptionId ? await BillingSubscription.find(invoice.subscriptionId) : null

  // Fresh = not an out-of-order replay of an event older than the last applied
  // one. No subscription row (a one-off charge) is treated as fresh so the
  // provider's own attempt count still drives `final`.
  const fresh = !sub || eventAt >= sub.lastEventAt.minus({ seconds: 5 })
  const alreadyCounted = sub?.dunningLastEventId === event.id
  let localAttempts = sub?.dunningAttempts ?? 0
  if (fresh && !alreadyCounted) localAttempts += 1
  const attempts = Math.max(invoice.attemptCount, localAttempts)
  const isFinal = fresh && attempts >= maxAttempts

  if (sub && fresh) {
    if (!alreadyCounted) {
      sub.dunningAttempts = localAttempts
      sub.dunningLastEventId = event.id
    }
    if (isFinal) {
      if (sub.status !== 'past_due' && sub.status !== 'canceled') {
        sub.status = 'past_due'
        sub.lastEventAt = eventAt
      }
      if (cfg?.dunning?.action === 'downgrade' && cfg.defaultPlan && gracePeriodDays > 0) {
        // Defer the downgrade — `tenant:billing:sweep` applies it once the
        // grace window elapses (and a recovery clears it first).
        sub.dunningDowngradeAt = eventAt.plus({ days: gracePeriodDays })
      }
    }
    if (sub.$isDirty) await sub.save()
  }

  // Immediate downgrade (grace period 0). Scheduled downgrades go through the
  // sweep instead, so this only runs when there's no grace window.
  if (isFinal && cfg?.dunning?.action === 'downgrade' && cfg.defaultPlan && gracePeriodDays === 0) {
    await applyDunningDowngrade(customer.tenantId, cfg.defaultPlan, ctx.logger)
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

/**
 * Reassign a tenant to its `defaultPlan` as the dunning `downgrade` action.
 * Shared by the immediate path here and the deferred grace-period path in
 * `tenant:billing:sweep`. Never throws — a failed downgrade is logged so the
 * webhook still acks (the next retry / sweep re-applies it idempotently).
 */
export async function applyDunningDowngrade(
  tenantId: string,
  defaultPlan: string,
  logger: Logger
): Promise<void> {
  try {
    const { QuotaService } = await import('@adonisjs-lasagna/saas-tenancy/services')
    const quotas = new QuotaService()
    await quotas.assignPlan(tenantId, defaultPlan, { source: 'dunning' })
  } catch (assignErr) {
    logger.error(
      { tenant_id: tenantId, err: (assignErr as Error)?.message },
      'billing.dunning.downgrade_failed: could not assign defaultPlan'
    )
  }
}

async function handleCustomerDeleted(
  event: EventOf<'customer.deleted'>,
  _ctx: DispatchContext
): Promise<DispatchResult> {
  // backoffice-scope-exempt: a provider webhook resolves the OWNING tenant by its provider customer id (no tenant_id exists to scope by until this returns).
  const row = await BillingCustomer.query()
    .where('providerCustomerId', event.data.providerCustomerId)
    .first()
  if (!row) return { outcome: 'noop' }
  row.deletedAt = DateTime.utc()
  await row.save()
  return { outcome: 'synced', tenant_id: row.tenantId ?? undefined }
}
