import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import type Stripe from 'stripe'
import { getConfig } from '../config.js'
import BillingException from '../exceptions/billing_exception.js'
import StripeCustomer from '../models/satellites/stripe_customer.js'
import StripeSubscription from '../models/satellites/stripe_subscription.js'
import type { StripeSubscriptionStatus } from '../models/satellites/stripe_subscription.js'
import StripeMeterEvent from '../models/satellites/stripe_meter_event.js'
import type { TenantModelContract } from '../types/contracts.js'
import { redactStripeEvent } from './billing/redact.js'

const lazyLogger = () =>
  import('@adonisjs/core/services/logger')
    .then((m) => m.default)
    .catch(() => null)

const lazyEmitter = () =>
  import('@adonisjs/core/services/emitter')
    .then((m) => m.default)
    .catch(() => null)

const DEFAULT_API_VERSION = '2025-08-27.basil'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_NETWORK_RETRIES = 3

/**
 * Defense-in-depth state machine for subscription status transitions.
 * The keys list every status we know Stripe can emit, mapping each to
 * the set of statuses Stripe is allowed to transition INTO.
 *
 * We never refuse a Stripe-driven transition — Stripe is the source of
 * truth and a refusal would just leave us out of sync. Instead, illegal
 * transitions log a warning so operators can investigate (Stripe bug,
 * support-tool override, our own out-of-order delivery, etc.).
 *
 * If Stripe adds a new status we haven't enumerated (`from`/`to` not in
 * the map), the helper logs a separate warning indicating the package
 * needs an update, but again does not block.
 */
const LEGAL_SUBSCRIPTION_TRANSITIONS: Record<
  StripeSubscriptionStatus,
  ReadonlySet<StripeSubscriptionStatus>
> = {
  incomplete: new Set(['active', 'trialing', 'incomplete_expired', 'canceled']),
  incomplete_expired: new Set([]), // terminal
  trialing: new Set(['active', 'past_due', 'unpaid', 'canceled', 'paused']),
  active: new Set(['past_due', 'unpaid', 'canceled', 'paused', 'trialing']),
  past_due: new Set(['active', 'canceled', 'unpaid', 'paused']),
  canceled: new Set([]), // terminal
  unpaid: new Set(['active', 'past_due', 'canceled']),
  paused: new Set(['active', 'canceled']),
}

export interface CreateCheckoutOptions {
  priceId: string
  successUrl: string
  cancelUrl: string
  mode?: 'subscription' | 'payment'
  trialDays?: number
  allowPromotionCodes?: boolean
  /** Defaults to `tenant.id`. Stripe surfaces this on the resulting subscription. */
  clientReferenceId?: string
  /**
   * Skip the priceId allowlist check against `config.billing.products`.
   * Default `false` (strict). Use only when the host validates priceIds
   * upstream (e.g., against a CMS-driven plan catalog). Setting this to
   * `true` re-opens the trust boundary — a controller that forwards
   * client-supplied price IDs without validation can be abused for
   * price manipulation.
   */
  allowUnknownPrices?: boolean
}

export interface CreatePortalOptions {
  returnUrl: string
}

export interface ReportUsageOptions {
  /** Custom idempotency key. Default: `<tenant>:<meter>:<uuid>`. */
  idempotencyKey?: string
  /** Event timestamp. Default: now. */
  timestamp?: DateTime
}

/**
 * The Stripe satellite. One singleton per process. Lazy-loads the Stripe
 * SDK on first use; verify() runs in `provider.boot()` to fail fast on
 * missing peer dep, mode mismatches, or invalid plan mappings.
 *
 * The package never imports `stripe` statically — only as `import type` —
 * so hosts that don't enable billing pay nothing for the SDK.
 */
export default class BillingService {
  #stripe: Stripe | null = null
  #verified = false

  /**
   * Boot-time validation. Idempotent (subsequent calls are no-ops). Runs
   * automatically from `MultitenancyProvider.boot()` when `config.billing`
   * is set; tests can call it directly.
   *
   * Verifies, in order:
   *   1. The `stripe` peer dep is installed.
   *   2. Test/live key matches `NODE_ENV` (with `STRIPE_ALLOW_LIVE_IN_DEV` escape hatch).
   *   3. `config.billing.defaultPlan` exists in `plans.definitions`.
   *   4. Every product mapping points at a declared plan.
   */
  async verify(): Promise<void> {
    if (this.#verified) return
    const cfg = getConfig().billing
    if (!cfg) return // Billing not configured — verify() is a no-op.

    await this.#getStripe() // throws BillingException('peer_missing') if SDK not installed

    const apiKey = cfg.stripe.apiKey ?? ''
    const isProduction = process.env.NODE_ENV === 'production'
    const isTestKey = apiKey.startsWith('sk_test_')
    const isLiveKey = apiKey.startsWith('sk_live_')

    if (isProduction && isTestKey) {
      throw new BillingException(
        'test_in_production',
        'STRIPE_API_KEY is a test key but NODE_ENV=production. Refusing to boot — set a live key or revert NODE_ENV.'
      )
    }
    // Mirror guard for live keys outside production. Hard-fail by default
    // because a stray .env from prod into dev silently moves real money.
    // The escape hatch (STRIPE_ALLOW_LIVE_IN_DEV=true) requires explicit
    // operator intent.
    if (!isProduction && isLiveKey && process.env.STRIPE_ALLOW_LIVE_IN_DEV !== 'true') {
      throw new BillingException(
        'live_key_outside_production',
        '[billing] STRIPE_API_KEY is a LIVE key but NODE_ENV is not "production". Refusing to boot — set NODE_ENV=production or STRIPE_ALLOW_LIVE_IN_DEV=true to opt in.'
      )
    }

    // Webhook secret presence + shape. An empty secret would let the SDK
    // compute HMAC against an empty key — trivially forgeable. A value
    // that doesn't start with `whsec_` is almost certainly the wrong env
    // var (operators sometimes paste STRIPE_API_KEY into the secret slot).
    // billing_doctor / billing_health_check report the same conditions at
    // runtime, but boot is the right place to fail fast.
    const webhookSecret = cfg.stripe.webhookSecret ?? ''
    if (!webhookSecret) {
      throw new BillingException(
        'config_missing',
        'config.billing.stripe.webhookSecret is empty — refusing to boot. Set STRIPE_WEBHOOK_SECRET.'
      )
    }
    if (!webhookSecret.startsWith('whsec_')) {
      throw new BillingException(
        'config_missing',
        'config.billing.stripe.webhookSecret does not start with "whsec_" — likely the wrong env var pasted into STRIPE_WEBHOOK_SECRET.'
      )
    }

    const plansCfg = getConfig().plans
    if (plansCfg && !plansCfg.definitions[cfg.defaultPlan]) {
      throw new BillingException(
        'config_missing',
        `config.billing.defaultPlan "${cfg.defaultPlan}" is not declared in config.plans.definitions`
      )
    }
    for (const [stripeId, planName] of Object.entries(cfg.products)) {
      if (plansCfg && !plansCfg.definitions[planName]) {
        throw new BillingException(
          'config_missing',
          `config.billing.products["${stripeId}"] = "${planName}" but that plan is not declared in config.plans.definitions`
        )
      }
    }

    this.#verified = true
  }

  /**
   * Returns the underlying Stripe SDK instance. Hosts can use this for
   * advanced operations not yet covered by helper methods, but should
   * prefer the typed helpers when possible (they apply consistent error
   * mapping and audit logging).
   */
  async getClient(): Promise<Stripe> {
    return this.#getStripe()
  }

  /**
   * Idempotent customer creation, race-safe under concurrency.
   *
   *   1. SELECT existing — fast path.
   *   2. Create in Stripe with `Idempotency-Key: tenant:<id>:create-customer`.
   *      Two concurrent calls hit Stripe but the second returns the same
   *      customer that the first created (Stripe-side dedupe).
   *   3. INSERT locally; on UNIQUE collision (another worker won), re-SELECT.
   *
   * Without the Stripe-side idempotency key, two concurrent workers under
   * a network blip would create two distinct customers in Stripe — the DB
   * UNIQUE constraint would catch it locally but the Stripe state would
   * be inconsistent forever.
   */
  async ensureCustomer(tenant: TenantModelContract): Promise<StripeCustomer> {
    const existing = await StripeCustomer.find(tenant.id)
    if (existing) return existing

    const stripe = await this.#getStripe()
    let stripeCustomer: Stripe.Customer
    try {
      stripeCustomer = await stripe.customers.create(
        {
          metadata: { tenantId: tenant.id },
          ...(tenant.email ? { email: tenant.email } : {}),
          ...(tenant.name ? { name: tenant.name } : {}),
        },
        { idempotencyKey: `tenant:${tenant.id}:create-customer` }
      )
    } catch (err) {
      throw BillingException.fromStripeError(err, 'failed to create Stripe customer')
    }

    try {
      const row = new StripeCustomer()
      row.tenantId = tenant.id
      row.stripeCustomerId = stripeCustomer.id
      row.currency = stripeCustomer.currency ?? null
      row.defaultPaymentMethod = null
      await row.save()
      return row
    } catch (err) {
      // UNIQUE collision on (tenant_id) PK — a concurrent worker won the race.
      // Re-read the canonical row.
      const winner = await StripeCustomer.find(tenant.id)
      if (winner) return winner
      throw err
    }
  }

  /**
   * Build a Stripe Checkout Session URL the host can 302 to. Auto-creates
   * the Stripe customer on first call (via `ensureCustomer`).
   *
   * `client_reference_id` is set to `tenant.id` by default — the webhook
   * job uses this on `checkout.session.completed` to reconcile customers
   * for tenants that hadn't reached `subscription.created` yet.
   */
  async createCheckoutSession(
    tenant: TenantModelContract,
    opts: CreateCheckoutOptions
  ): Promise<{ url: string; id: string }> {
    if (!opts.allowUnknownPrices) {
      await this.#assertPriceAllowed(opts.priceId)
    }
    const customer = await this.ensureCustomer(tenant)
    const stripe = await this.#getStripe()

    try {
      const session = await stripe.checkout.sessions.create({
        mode: opts.mode ?? 'subscription',
        customer: customer.stripeCustomerId,
        client_reference_id: opts.clientReferenceId ?? tenant.id,
        line_items: [{ price: opts.priceId, quantity: 1 }],
        success_url: opts.successUrl,
        cancel_url: opts.cancelUrl,
        allow_promotion_codes: opts.allowPromotionCodes ?? false,
        ...(opts.mode === 'subscription' && opts.trialDays
          ? { subscription_data: { trial_period_days: opts.trialDays } }
          : {}),
        metadata: { tenantId: tenant.id },
      })
      if (!session.url) {
        throw new BillingException('api_error', 'Stripe Checkout did not return a URL', {
          status: 500,
        })
      }
      return { url: session.url, id: session.id }
    } catch (err) {
      if (err instanceof BillingException) throw err
      throw BillingException.fromStripeError(err, 'failed to create checkout session')
    }
  }

  /** Build a Stripe Billing Portal session URL — manage payment method, view invoices, cancel. */
  async createBillingPortalSession(
    tenant: TenantModelContract,
    opts: CreatePortalOptions
  ): Promise<{ url: string }> {
    const customer = await StripeCustomer.find(tenant.id)
    if (!customer) {
      throw new BillingException(
        'customer_not_found',
        'Tenant has no Stripe customer yet — start with createCheckoutSession()'
      )
    }
    const stripe = await this.#getStripe()
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: customer.stripeCustomerId,
        return_url: opts.returnUrl,
      })
      return { url: session.url }
    } catch (err) {
      throw BillingException.fromStripeError(err, 'failed to create billing portal session')
    }
  }

  /**
   * Reconcile a Stripe Subscription into our local mirror + plan assignment.
   * Called by `ProcessStripeEventJob` for `customer.subscription.{created,
   * updated,deleted,paused,resumed}`.
   *
   * Ordering guard: rejects events whose `created` timestamp is older than
   * the local `last_event_at - 5s` (Stripe does not guarantee delivery
   * order). Without this, a stale `subscription.updated` would revive a
   * canceled subscription.
   *
   * Plan validation: if the Stripe product has no entry in
   * `config.billing.products`, falls back to `defaultPlan` and emits a
   * `BillingMisconfigured` event so the host knows to update config.
   */
  async syncSubscription(
    sub: Stripe.Subscription,
    eventCreated: number,
    opts?: { downgrade?: boolean }
  ): Promise<{ tenant_id: string; plan: string; previousPlan: string | null } | null> {
    const cfg = getConfig().billing
    if (!cfg) throw new BillingException('config_missing', 'config.billing is not configured')

    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
    if (!customerId) {
      throw new BillingException(
        'tenant_not_resolvable',
        'subscription has no customer id — refusing to sync'
      )
    }

    const customer = await StripeCustomer.query()
      .where('stripeCustomerId', customerId)
      .first()
    if (!customer) {
      throw new BillingException(
        'tenant_not_resolvable',
        `no local stripe_customers row for ${customerId} — checkout.session.completed must arrive first`
      )
    }

    // Ordering guard — discard stale events.
    const eventAt = DateTime.fromSeconds(eventCreated)
    const existing = await StripeSubscription.find(sub.id)
    if (existing && eventAt < existing.lastEventAt.minus({ seconds: 5 })) {
      const logger = await lazyLogger()
      logger?.warn(
        {
          stripe_subscription_id: sub.id,
          event_created: eventCreated,
          last_event_at: existing.lastEventAt.toISO(),
        },
        'stripe.event.stale: dropping out-of-order subscription event'
      )
      return null
    }

    // Plan resolution from Stripe product → local plan name.
    const previousPlan = existing?.planName ?? null
    let planName = cfg.defaultPlan
    if (!opts?.downgrade) {
      const item = sub.items?.data?.[0]
      const productId =
        typeof item?.price?.product === 'string'
          ? item.price.product
          : item?.price?.product?.id
      const priceId = item?.price?.id
      const mapped =
        (productId && cfg.products[productId]) ?? (priceId && cfg.products[priceId])
      if (mapped) {
        planName = mapped
      } else if (productId || priceId) {
        const logger = await lazyLogger()
        logger?.error(
          { product_id: productId, price_id: priceId, stripe_subscription_id: sub.id },
          'stripe.product.unmapped: subscription product is not in config.billing.products — falling back to defaultPlan'
        )
        await this.#emitMisconfigured({
          stripeSubscriptionId: sub.id,
          productId: productId ?? null,
          priceId: priceId ?? null,
        })
      }
    }

    // Upsert local mirror.
    const status = sub.status as StripeSubscriptionStatus

    // State machine guard. Logs only — never blocks (Stripe is the
    // source of truth, even when Stripe sends something surprising).
    if (existing && existing.status !== status) {
      const allowed = LEGAL_SUBSCRIPTION_TRANSITIONS[existing.status]
      if (!allowed) {
        const logger = await lazyLogger()
        logger?.warn(
          {
            stripe_subscription_id: sub.id,
            from: existing.status,
            to: status,
          },
          'stripe.subscription.unknown_source_state: existing status is not enumerated — investigate / update package'
        )
      } else if (!allowed.has(status)) {
        const logger = await lazyLogger()
        logger?.warn(
          {
            stripe_subscription_id: sub.id,
            from: existing.status,
            to: status,
          },
          'stripe.subscription.illegal_transition: applying anyway, but the source/target combo is not in the legal table'
        )
      }
    }

    const row = existing ?? new StripeSubscription()
    // Stripe moved `current_period_{start,end}` from the top of Subscription
    // onto each `items.data[i]` in the 2025 API. Read the new location first;
    // fall back to the legacy field via raw access for older API pinnings.
    const subItem = sub.items?.data?.[0] as
      | { current_period_start?: number; current_period_end?: number }
      | undefined
    const subRaw = sub as unknown as {
      current_period_start?: number
      current_period_end?: number
    }
    const periodStart =
      subItem?.current_period_start ?? subRaw.current_period_start ?? eventCreated
    const periodEnd = subItem?.current_period_end ?? subRaw.current_period_end ?? eventCreated
    row.stripeSubscriptionId = sub.id
    row.tenantId = customer.tenantId
    row.status = status
    row.currentPeriodStart = DateTime.fromSeconds(periodStart)
    row.currentPeriodEnd = DateTime.fromSeconds(periodEnd)
    row.cancelAtPeriodEnd = sub.cancel_at_period_end ?? false
    row.cancelAt = sub.cancel_at ? DateTime.fromSeconds(sub.cancel_at) : null
    row.canceledAt = sub.canceled_at ? DateTime.fromSeconds(sub.canceled_at) : null
    row.trialEnd = sub.trial_end ? DateTime.fromSeconds(sub.trial_end) : null
    row.planName = planName
    row.lastEventAt = eventAt
    row.raw = sub as unknown as Record<string, unknown>

    // Apply plan to QuotaService BEFORE persisting the mirror. If the
    // quota write fails (Redis blip, plan removed from config, DB
    // hiccup) we do NOT want a half-applied state where the local
    // subscription mirror reflects the new plan but the tenant's
    // enforced limits still match the old one. With this ordering,
    // a failing assignPlan() leaves both the mirror and the quota in
    // their pre-event state — the next webhook retry re-runs the
    // whole flow idempotently. assignPlan() is itself idempotent
    // (same plan = no-op).
    //
    // Lazy import avoids a circular dep (QuotaService → events →
    // BillingService → QuotaService).
    const { default: QuotaService } = await import('./quota_service.js')
    const quotas = new QuotaService()
    await quotas.assignPlan(customer.tenantId, planName, { source: 'stripe' })

    await row.save()

    return { tenant_id: customer.tenantId, plan: planName, previousPlan }
  }

  /**
   * Report a usage-based meter event to Stripe. Persists a local audit row
   * in `stripe_meter_events` with a UNIQUE idempotency_key so retries can't
   * double-report.
   *
   * Default idempotency key is non-deterministic (`<tenant>:<meter>:<uuid>`)
   * — pass `opts.idempotencyKey` to dedupe against an external request id.
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

    const customer = await StripeCustomer.find(tenant.id)
    if (!customer) {
      throw new BillingException(
        'customer_not_found',
        `tenant ${tenant.id} has no Stripe customer — cannot report usage`
      )
    }

    // Default key is deterministic per (tenant, meter, minute-bucket).
    // A retry within the same minute hits Stripe's idempotency cache and
    // doesn't double-count usage. Random UUIDs would defeat the purpose
    // of an idempotency key — they're not a security boundary, they're a
    // dedupe contract. Callers needing tighter scope (e.g. per-request
    // dedupe) pass `opts.idempotencyKey`.
    const minuteBucket = Math.floor((opts?.timestamp ?? DateTime.utc()).toSeconds() / 60)
    const idempotencyKey =
      opts?.idempotencyKey ?? `${tenant.id}:${meter.eventName}:${minuteBucket}`
    const timestamp = opts?.timestamp ?? DateTime.utc()

    // Fetch any prior attempt for this idempotency key. Three cases:
    //   1. None exists → fresh insert (the typical happy path).
    //   2. Exists, status='sent' → already reported; short-circuit. This
    //      is the idempotent return — caller can safely retry the same
    //      key without producing a UNIQUE violation.
    //   3. Exists, status='pending' or 'failed' → a prior attempt
    //      either crashed mid-flight (DB blip after Stripe success
    //      stuck the row in 'pending') or genuinely failed. Reuse
    //      the row and retry the Stripe call. Stripe's own
    //      idempotency cache will dedupe so the meter is not
    //      double-counted.
    let audit = await StripeMeterEvent.query()
      .where('idempotencyKey', idempotencyKey)
      .first()
    if (audit?.status === 'sent') return

    if (!audit) {
      audit = new StripeMeterEvent()
      audit.id = randomUUID()
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
        // Concurrent insert won the race on the UNIQUE(idempotency_key)
        // constraint. Re-read and continue with the winner's row so
        // both callers converge on the same audit record.
        audit = await StripeMeterEvent.query()
          .where('idempotencyKey', idempotencyKey)
          .first()
        if (!audit) throw err
        if (audit.status === 'sent') return
      }
    }

    const stripe = await this.#getStripe()
    try {
      await stripe.billing.meterEvents.create(
        {
          event_name: meter.eventName,
          payload: {
            stripe_customer_id: customer.stripeCustomerId,
            value: String(quantity),
          },
          timestamp: Math.floor(timestamp.toSeconds()),
        },
        { idempotencyKey }
      )
      audit.status = 'sent'
      audit.reportedAt = DateTime.utc()
      audit.attempts = audit.attempts + 1
      audit.lastError = null
      await audit.save()
    } catch (err) {
      audit.status = 'failed'
      audit.lastError = (err as Error)?.message?.slice(0, 500) ?? 'unknown error'
      audit.attempts = audit.attempts + 1
      // Best-effort save — do not mask the original Stripe error if the
      // audit write itself blips. The next retry recovers via the
      // idempotency-key lookup above.
      await audit.save().catch(() => {})
      throw BillingException.fromStripeError(err, 'failed to report meter event')
    }
  }

  /**
   * Re-fetch a webhook event from Stripe. The job uses this instead of
   * trusting the queue payload — guards against tampering and reduces
   * message size. Falls back to the locally-persisted `payload` jsonb for
   * events older than Stripe's 30-day retrieval window.
   */
  async retrieveEvent(eventId: string): Promise<Stripe.Event> {
    const stripe = await this.#getStripe()
    try {
      return await stripe.events.retrieve(eventId)
    } catch (err) {
      throw BillingException.fromStripeError(err, `failed to retrieve event ${eventId}`)
    }
  }

  /** @internal — exposed for tests; do not use in app code. */
  async __getStripeUnsafe(): Promise<Stripe> {
    return this.#getStripe()
  }

  /** @internal — exposed for tests; resets the cached client + verified flag. */
  __resetForTests(): void {
    this.#stripe = null
    this.#verified = false
  }

  /**
   * @internal — inject a mock Stripe SDK (typically `MockStripe` from
   * `@adonisjs-lasagna/saas-tenancy/testing`). Sets `verified=true` so the
   * mock skips boot-time peer-dep / mode checks. Tests must reset the
   * injection between cases via `__resetForTests()`.
   */
  __setStripeForTests(client: unknown): void {
    this.#stripe = client as Stripe
    this.#verified = true
  }

  async #getStripe(): Promise<Stripe> {
    if (this.#stripe) return this.#stripe
    const cfg = getConfig().billing
    if (!cfg) {
      throw new BillingException('config_missing', 'config.billing is not configured')
    }

    let StripeCtor: typeof Stripe
    try {
      const mod = (await import('stripe')) as unknown as {
        default: typeof Stripe
      }
      StripeCtor = mod.default ?? (mod as unknown as typeof Stripe)
    } catch {
      throw new BillingException(
        'peer_missing',
        '[billing] config.billing is set but the `stripe` peer dep is not installed. Run: npm install stripe@^18'
      )
    }

    this.#stripe = new StripeCtor(cfg.stripe.apiKey, {
      apiVersion: (cfg.stripe.apiVersion ?? DEFAULT_API_VERSION) as Stripe.LatestApiVersion,
      timeout: cfg.stripe.timeout ?? DEFAULT_TIMEOUT_MS,
      maxNetworkRetries: cfg.stripe.maxNetworkRetries ?? DEFAULT_NETWORK_RETRIES,
    })
    return this.#stripe
  }

  /**
   * Verify the priceId resolves to a product/price declared in
   * `config.billing.products`. Default trust boundary for checkout: if a
   * controller forwards a client-supplied priceId, this prevents an
   * attacker from picking a different tenant's plan, a $0 price, or any
   * arbitrary line item.
   *
   * Two-pass check:
   *   1. Fast path — priceId itself is a key in `cfg.products`
   *      (operators using price-level allowlists).
   *   2. Fallback — fetch the price from Stripe and check its productId
   *      against `cfg.products` (operators using product-level mapping,
   *      where one product has many prices: monthly, yearly, etc.).
   *
   * Hosts that validate priceIds elsewhere (CMS catalog, hardcoded list)
   * can bypass via `opts.allowUnknownPrices = true` on the checkout call.
   */
  async #assertPriceAllowed(priceId: string): Promise<void> {
    const cfg = getConfig().billing
    if (!cfg) {
      throw new BillingException('config_missing', 'config.billing is not configured')
    }
    if (priceId in cfg.products) return

    let productId: string | null = null
    try {
      const stripe = await this.#getStripe()
      const price = await stripe.prices.retrieve(priceId)
      productId =
        typeof price.product === 'string'
          ? price.product
          : (price.product?.id ?? null)
    } catch (err) {
      // Stripe rejected the lookup (invalid_request_error for an unknown
      // price, or auth/network). Either way the priceId can't be trusted
      // — propagate as a billing error rather than the raw Stripe error.
      throw BillingException.fromStripeError(
        err,
        `priceId "${priceId}" could not be verified against Stripe`
      )
    }

    if (productId && productId in cfg.products) return

    throw new BillingException(
      'invalid_price',
      `priceId "${priceId}"${productId ? ` (product "${productId}")` : ''} is not in config.billing.products allowlist. ` +
        `Add it to the mapping or pass allowUnknownPrices: true if the host validates upstream.`
    )
  }

  async #emitMisconfigured(payload: {
    stripeSubscriptionId: string
    productId: string | null
    priceId: string | null
  }): Promise<void> {
    try {
      const emitter = await lazyEmitter()
      const { default: BillingMisconfigured } = await import(
        '../events/billing/billing_misconfigured.js'
      )
      // BaseEvent.dispatch reaches the global emitter via the singleton, so
      // we don't strictly need to use the bound `emitter` here — keep the
      // resolution to surface broken wiring early.
      if (!emitter) return
      await BillingMisconfigured.dispatch(payload)
    } catch {
      // Misconfig emit is best-effort — never throw from the sync path.
    }
  }
}

/** Re-export for `import { redactStripeEvent } from '.../services'`. */
export { redactStripeEvent }
