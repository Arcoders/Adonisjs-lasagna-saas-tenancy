import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import BillingException from '../exceptions/billing_exception.js'
import BillingCustomer from '../models/satellites/billing_customer.js'
import BillingSubscription from '../models/satellites/billing_subscription.js'
import type { BillingSubscriptionStatus } from '../models/satellites/billing_subscription.js'
import BillingUsageEvent from '../models/satellites/billing_usage_event.js'
import BillingProcessedEvent from '../models/satellites/billing_processed_event.js'
import { getActiveBillingDriver } from './billing/active_billing_driver.js'
import type { BillingProviderContract } from '../contracts/billing_provider_contract.js'
import type {
  BillingCapability,
  BillingWebhookEvent,
  CheckoutOptions,
  PortalOptions,
  Subscription,
} from '../contracts/types.js'
import { rebuildBillingEvent } from './billing/redact.js'
import { redactBillingEvent } from './billing/redact.js'

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

const lazyEmitter = () =>
  import('@adonisjs/core/services/emitter').then((m) => m.default).catch(() => null)

/**
 * Defense-in-depth state machine for subscription status transitions. Keys list
 * every status a provider can emit, mapped to the set it may transition INTO.
 *
 * We never refuse a provider-driven transition — the provider is the source of
 * truth and a refusal would just leave us out of sync. Illegal transitions log
 * a warning so operators can investigate.
 */
const LEGAL_SUBSCRIPTION_TRANSITIONS: Record<
  BillingSubscriptionStatus,
  ReadonlySet<BillingSubscriptionStatus>
> = {
  incomplete: new Set(['active', 'trialing', 'incomplete_expired', 'canceled']),
  incomplete_expired: new Set([]),
  trialing: new Set(['active', 'past_due', 'unpaid', 'canceled', 'paused']),
  active: new Set(['past_due', 'unpaid', 'canceled', 'paused', 'trialing']),
  past_due: new Set(['active', 'canceled', 'unpaid', 'paused']),
  canceled: new Set([]),
  unpaid: new Set(['active', 'past_due', 'canceled']),
  paused: new Set(['active', 'canceled']),
}

export interface CreateCheckoutOptions extends CheckoutOptions {
  /**
   * Skip the priceId allowlist check against `config.billing.products`.
   * Default `false` (strict). Setting `true` re-opens the trust boundary —
   * only use it when the host validates priceIds upstream.
   */
  allowUnknownPrices?: boolean
}

export type CreatePortalOptions = PortalOptions

export interface ReportUsageOptions {
  /**
   * Custom idempotency key. Default `<tenant>:<meter>:<minute-bucket>`, which is
   * deterministic per (tenant, meter, minute), so a retry within the same minute
   * hits the provider's idempotency cache and never double-counts.
   */
  idempotencyKey?: string
  /** Event timestamp. Default: now. */
  timestamp?: DateTime
}

/**
 * The billing satellite orchestrator. One singleton per process. Provider-
 * agnostic: it owns the database mirror, plan assignment, audit rows, and the
 * checkout price allowlist, and delegates every provider call to the active
 * driver resolved from `BillingDriverRegistry`.
 *
 * The package never imports a provider SDK statically — drivers lazy-load
 * theirs — so hosts pay nothing for providers they don't use.
 */
export default class BillingService {
  #verified = false

  /**
   * Boot-time validation. Idempotent. Runs from `BillingProvider.boot()` when
   * `config.billing` is set. Validates the active driver's config slice
   * (`driver.verifyConfig()`) plus the driver-agnostic plan mappings.
   */
  async verify(): Promise<void> {
    if (this.#verified) return
    const cfg = getConfig().billing
    if (!cfg) return

    const driver = await getActiveBillingDriver()
    await driver.verifyConfig()

    const plansCfg = getConfig().plans
    if (plansCfg && !plansCfg.definitions[cfg.defaultPlan]) {
      throw new BillingException(
        'config_missing',
        `config.billing.defaultPlan "${cfg.defaultPlan}" is not declared in config.plans.definitions`
      )
    }
    for (const [productId, planName] of Object.entries(cfg.products)) {
      if (plansCfg && !plansCfg.definitions[planName]) {
        throw new BillingException(
          'config_missing',
          `config.billing.products["${productId}"] = "${planName}" but that plan is not declared in config.plans.definitions`
        )
      }
    }

    this.#verified = true
  }

  /**
   * Idempotent, race-safe customer creation. Fast-path SELECT, then delegate
   * the remote create to the driver, then INSERT the local mirror; on a UNIQUE
   * collision (a concurrent worker won) re-SELECT.
   */
  async ensureCustomer(tenant: TenantModelContract): Promise<BillingCustomer> {
    const existing = await BillingCustomer.find(tenant.id)
    if (existing) return existing

    const driver = await getActiveBillingDriver()
    const remote = await driver.ensureCustomer(tenant)

    try {
      const row = new BillingCustomer()
      row.tenantId = tenant.id
      row.provider = driver.name
      row.providerCustomerId = remote.providerCustomerId
      row.currency = remote.currency
      row.defaultPaymentMethod = remote.defaultPaymentMethod
      await row.save()
      return row
    } catch (err) {
      const winner = await BillingCustomer.find(tenant.id)
      if (winner) return winner
      throw err
    }
  }

  /**
   * Build a hosted checkout URL the host can 302 to. Auto-creates the provider
   * customer on first call. Enforces the priceId allowlist unless
   * `allowUnknownPrices` is set.
   */
  async createCheckoutSession(
    tenant: TenantModelContract,
    opts: CreateCheckoutOptions
  ): Promise<{ url: string; id: string }> {
    const driver = await getActiveBillingDriver()
    if (!opts.allowUnknownPrices) {
      await this.#assertPriceAllowed(driver, opts.priceId)
    }
    const customer = await this.ensureCustomer(tenant)
    return driver.createCheckoutSession(tenant, customer.providerCustomerId, opts)
  }

  /** Build a customer/billing-portal URL. Requires a `billing_portal` driver. */
  async createBillingPortalSession(
    tenant: TenantModelContract,
    opts: CreatePortalOptions
  ): Promise<{ url: string }> {
    const customer = await BillingCustomer.find(tenant.id)
    if (!customer) {
      throw new BillingException(
        'customer_not_found',
        'Tenant has no billing customer yet — start with createCheckoutSession()'
      )
    }
    const driver = await getActiveBillingDriver()
    this.#assertSupports(driver, 'billing_portal')
    return driver.createBillingPortalSession!(customer.providerCustomerId, opts)
  }

  /**
   * Reconcile a neutral subscription into the local mirror + plan assignment.
   * Called by the dispatcher for upsert/deleted/paused/resumed events.
   *
   * Ordering guard: rejects events older than `last_event_at - 5s` (providers
   * don't guarantee delivery order). Plan validation: an unmapped product falls
   * back to `defaultPlan` and emits `BillingMisconfigured`.
   */
  async syncSubscription(
    sub: Subscription,
    eventCreated: number,
    opts?: { downgrade?: boolean }
  ): Promise<{ tenant_id: string; plan: string; previousPlan: string | null } | null> {
    const cfg = getConfig().billing
    if (!cfg) throw new BillingException('config_missing', 'config.billing is not configured')

    if (!sub.customerId) {
      throw new BillingException(
        'tenant_not_resolvable',
        'subscription has no customer id — refusing to sync'
      )
    }

    const driver = await getActiveBillingDriver()
    const customer = await BillingCustomer.query()
      .where('providerCustomerId', sub.customerId)
      .first()
    if (!customer) {
      throw new BillingException(
        'tenant_not_resolvable',
        `no local billing_customers row for ${sub.customerId} — checkout must arrive first`
      )
    }

    const eventAt = DateTime.fromSeconds(eventCreated)
    const existing = await BillingSubscription.find(sub.providerSubscriptionId)
    if (existing && eventAt < existing.lastEventAt.minus({ seconds: 5 })) {
      const logger = await lazyLogger()
      logger?.warn(
        {
          provider_subscription_id: sub.providerSubscriptionId,
          event_created: eventCreated,
          last_event_at: existing.lastEventAt.toISO(),
        },
        'billing.event.stale: dropping out-of-order subscription event'
      )
      return null
    }

    const previousPlan = existing?.planName ?? null
    let planName = cfg.defaultPlan
    if (!opts?.downgrade) {
      const mapped =
        (sub.productId && cfg.products[sub.productId]) ?? (sub.priceId && cfg.products[sub.priceId])
      if (mapped) {
        planName = mapped
      } else if (sub.productId || sub.priceId) {
        const logger = await lazyLogger()
        logger?.error(
          {
            product_id: sub.productId,
            price_id: sub.priceId,
            provider_subscription_id: sub.providerSubscriptionId,
          },
          'billing.product.unmapped: subscription product is not in config.billing.products — falling back to defaultPlan'
        )
        await this.#emitMisconfigured({
          subscriptionId: sub.providerSubscriptionId,
          productId: sub.productId,
          priceId: sub.priceId,
        })
      }
    }

    const status = sub.status

    if (existing && existing.status !== status) {
      const allowed = LEGAL_SUBSCRIPTION_TRANSITIONS[existing.status]
      const logger = await lazyLogger()
      if (!allowed) {
        logger?.warn(
          {
            provider_subscription_id: sub.providerSubscriptionId,
            from: existing.status,
            to: status,
          },
          'billing.subscription.unknown_source_state: existing status is not enumerated — investigate / update package'
        )
      } else if (!allowed.has(status)) {
        logger?.warn(
          {
            provider_subscription_id: sub.providerSubscriptionId,
            from: existing.status,
            to: status,
          },
          'billing.subscription.illegal_transition: applying anyway, but the source/target combo is not in the legal table'
        )
      }
    }

    const row = existing ?? new BillingSubscription()
    row.providerSubscriptionId = sub.providerSubscriptionId
    row.provider = driver.name
    row.tenantId = customer.tenantId
    row.status = status
    row.currentPeriodStart = DateTime.fromSeconds(sub.currentPeriodStart)
    row.currentPeriodEnd = DateTime.fromSeconds(sub.currentPeriodEnd)
    row.cancelAtPeriodEnd = sub.cancelAtPeriodEnd
    row.cancelAt = sub.cancelAt ? DateTime.fromSeconds(sub.cancelAt) : null
    row.canceledAt = sub.canceledAt ? DateTime.fromSeconds(sub.canceledAt) : null
    row.trialEnd = sub.trialEnd ? DateTime.fromSeconds(sub.trialEnd) : null
    row.planName = planName
    row.lastEventAt = eventAt
    row.raw = sub.raw

    // Apply the plan to QuotaService BEFORE persisting the mirror. A failing
    // assignPlan() leaves both the mirror and the quota in their pre-event
    // state, and the next webhook retry re-runs the whole flow idempotently.
    // Lazy import avoids a circular dep (QuotaService → events → here).
    const { QuotaService } = await import('@adonisjs-lasagna/saas-tenancy/services')
    const quotas = new QuotaService()
    await quotas.assignPlan(customer.tenantId, planName, { source: driver.name })

    await row.save()

    return { tenant_id: customer.tenantId, plan: planName, previousPlan }
  }

  /**
   * Report a usage-based meter event through the active driver. Persists a
   * local audit row in `billing_usage_events` with a UNIQUE idempotency_key so
   * retries can't double-report. Requires a `usage_metering` driver.
   */
  async reportUsage(
    tenant: TenantModelContract,
    meter: { eventName: string },
    quantity: number,
    opts?: ReportUsageOptions
  ): Promise<void> {
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new BillingException(
        'metering_failed',
        `reportUsage: quantity must be a non-negative finite number, got ${quantity}`
      )
    }

    const customer = await BillingCustomer.find(tenant.id)
    if (!customer) {
      throw new BillingException(
        'customer_not_found',
        `tenant ${tenant.id} has no billing customer — cannot report usage`
      )
    }

    const driver = await getActiveBillingDriver()
    this.#assertSupports(driver, 'usage_metering')

    const timestamp = opts?.timestamp ?? DateTime.utc()
    const minuteBucket = Math.floor(timestamp.toSeconds() / 60)
    const idempotencyKey = opts?.idempotencyKey ?? `${tenant.id}:${meter.eventName}:${minuteBucket}`

    let audit = await BillingUsageEvent.query().where('idempotencyKey', idempotencyKey).first()
    if (audit?.status === 'sent') return

    if (!audit) {
      audit = new BillingUsageEvent()
      audit.id = randomUUID()
      audit.provider = driver.name
      audit.tenantId = tenant.id
      audit.meterEventName = meter.eventName
      audit.quantity = quantity
      audit.idempotencyKey = idempotencyKey
      audit.status = 'pending'
      audit.attempts = 0
      audit.lastError = null
      audit.reportedAt = null
      try {
        await audit.save()
      } catch (err) {
        audit = await BillingUsageEvent.query().where('idempotencyKey', idempotencyKey).first()
        if (!audit) throw err
        if (audit.status === 'sent') return
      }
    }

    try {
      await driver.reportUsage!(customer.providerCustomerId, meter, quantity, {
        idempotencyKey,
        timestampSeconds: Math.floor(timestamp.toSeconds()),
      })
      audit.status = 'sent'
      audit.reportedAt = DateTime.utc()
      audit.attempts = audit.attempts + 1
      audit.lastError = null
      await audit.save()
    } catch (err) {
      audit.status = 'failed'
      audit.lastError = (err as Error)?.message?.slice(0, 500) ?? 'unknown error'
      audit.attempts = audit.attempts + 1
      await audit.save().catch(() => {})
      throw err instanceof BillingException
        ? err
        : new BillingException('metering_failed', 'failed to report meter event', { cause: err })
    }
  }

  /**
   * Re-fetch a webhook event as the source of truth. Uses the driver's tamper
   * guard (`retrieveEvent`) when supported; falls back to the signature-verified
   * replay payload persisted at receive time (the aged-out case, and the only
   * path for drivers without event retrieval).
   */
  async retrieveEvent(eventId: string): Promise<BillingWebhookEvent> {
    const driver = await getActiveBillingDriver()
    if (driver.supports('event_retrieval') && driver.retrieveEvent) {
      const fetched = await driver.retrieveEvent(eventId)
      if (fetched) return fetched
    }
    const local = await this.#replayFromLocalPayload(eventId)
    if (local) return local
    throw new BillingException(
      'api_error',
      `event ${eventId} could not be retrieved and has no stored replay payload`,
      { status: 500 }
    )
  }

  async #replayFromLocalPayload(eventId: string): Promise<BillingWebhookEvent | null> {
    const row = await BillingProcessedEvent.find(eventId)
    return row?.payload ? rebuildBillingEvent(row.payload) : null
  }

  /**
   * @internal — advanced host access / tests. Returns the raw Stripe SDK; only
   * valid when the active driver is Stripe.
   */
  async getClient(): Promise<unknown> {
    const driver = await getActiveBillingDriver()
    const withClient = driver as { getClient?: () => Promise<unknown> }
    if (driver.name !== 'stripe' || typeof withClient.getClient !== 'function') {
      throw new BillingException(
        'unsupported_by_driver',
        'getClient() returns the Stripe SDK and is only available with the Stripe driver'
      )
    }
    return withClient.getClient()
  }

  /** @internal — inject a mock provider SDK into the active driver (tests). */
  async __setStripeForTests(client: unknown): Promise<void> {
    this.#verified = true
    const driver = await getActiveBillingDriver().catch(() => null)
    ;(driver as { __setStripeForTests?: (c: unknown) => void } | null)?.__setStripeForTests?.(
      client
    )
  }

  /** @internal — reset the cached SDK + verified flag (tests). */
  async __resetForTests(): Promise<void> {
    this.#verified = false
    const driver = await getActiveBillingDriver().catch(() => null)
    ;(driver as { __resetForTests?: () => void } | null)?.__resetForTests?.()
  }

  #assertSupports(driver: BillingProviderContract, capability: BillingCapability): void {
    if (!driver.supports(capability)) {
      throw new BillingException(
        'unsupported_by_driver',
        `the "${driver.name}" billing driver does not support "${capability}"`
      )
    }
  }

  /**
   * Verify the priceId resolves to a product/price declared in
   * `config.billing.products`. Fast path: the priceId is itself a key. Fallback:
   * ask the driver to resolve price→product (when it supports `price_lookup`).
   */
  async #assertPriceAllowed(driver: BillingProviderContract, priceId: string): Promise<void> {
    const cfg = getConfig().billing
    if (!cfg) {
      throw new BillingException('config_missing', 'config.billing is not configured')
    }
    if (priceId in cfg.products) return

    if (!driver.supports('price_lookup') || !driver.resolvePriceProduct) {
      throw new BillingException(
        'invalid_price',
        `priceId "${priceId}" is not in config.billing.products allowlist and the "${driver.name}" ` +
          `driver cannot resolve it. Add it to the mapping or pass allowUnknownPrices: true.`
      )
    }

    const price = await driver.resolvePriceProduct(priceId)
    const productId = price?.productId ?? null
    if (productId && productId in cfg.products) return

    throw new BillingException(
      'invalid_price',
      `priceId "${priceId}"${productId ? ` (product "${productId}")` : ''} is not in config.billing.products allowlist. ` +
        `Add it to the mapping or pass allowUnknownPrices: true if the host validates upstream.`
    )
  }

  async #emitMisconfigured(payload: {
    subscriptionId: string
    productId: string | null
    priceId: string | null
  }): Promise<void> {
    try {
      const emitter = await lazyEmitter()
      const { default: BillingMisconfigured } =
        await import('../events/billing/billing_misconfigured.js')
      if (!emitter) return
      await BillingMisconfigured.dispatch(payload)
    } catch {
      // Best-effort — never throw from the sync path.
    }
  }
}

/** Re-export for `import { redactBillingEvent } from '.../services'`. */
export { redactBillingEvent }
