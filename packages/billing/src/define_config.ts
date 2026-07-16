import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The shipped billing driver names. `(string & {})` keeps autocomplete for the
 * built-ins while admitting a custom driver a host registers on
 * `BillingDriverRegistry`. Owned by the billing satellite (not core) so core's
 * frozen public type stays free of satellite-specific shapes.
 */
export type BillingDriverChoice = 'stripe' | 'paddle' | 'lemonsqueezy' | (string & {})

/**
 * Billing satellite: opt-in via `--with=billing` and declaring `config.billing`.
 * Provider-agnostic: pick `driver` and fill in the matching config block.
 * Documented end-to-end in `docs/guides/cookbook/stripe-quotas.md`.
 *
 * Plays platform-mode only (one provider account, tenants are subscribers).
 */
export interface BillingConfig {
  /**
   * Which billing provider to use. The matching config block below
   * (`stripe` / `paddle` / `lemonSqueezy`) must be present; the driver's
   * `verifyConfig()` validates it at boot.
   */
  driver: BillingDriverChoice
  /** Stripe driver config. Required when `driver: 'stripe'`. */
  stripe?: {
    /** Secret key. Read from `STRIPE_API_KEY`. Boot fails if `sk_live_*` and `NODE_ENV !== 'production'` unless `STRIPE_ALLOW_LIVE_IN_DEV=true`. */
    apiKey: string
    /** Webhook signing secret. Read from `STRIPE_WEBHOOK_SECRET`. */
    webhookSecret: string
    /** Pin Stripe API version. Default `'2025-08-27.basil'`. */
    apiVersion?: string
    /** SDK request timeout in ms. Default 10_000. */
    timeout?: number
    /** SDK network retry attempts. Default 3. */
    maxNetworkRetries?: number
  }
  /** Paddle Billing driver config. Required when `driver: 'paddle'`. */
  paddle?: {
    /** API key. Read from `PADDLE_API_KEY`. */
    apiKey: string
    /** Webhook signing secret (`Paddle-Signature`). Read from `PADDLE_WEBHOOK_SECRET`. */
    webhookSecret: string
    /** `'sandbox'` (default) or `'production'`. */
    environment?: 'sandbox' | 'production'
  }
  /** Lemon Squeezy driver config. Required when `driver: 'lemonsqueezy'`. */
  lemonSqueezy?: {
    /** API key. Read from `LEMONSQUEEZY_API_KEY`. */
    apiKey: string
    /** Webhook signing secret (`X-Signature`). Read from `LEMONSQUEEZY_WEBHOOK_SECRET`. */
    webhookSecret: string
    /** Store id checkouts are created against. Read from `LEMONSQUEEZY_STORE_ID`. */
    storeId: string
  }
  /** Provider product (or price/variant) ID maps to plan name. Plan must exist in `plans.definitions`. */
  products: Record<string, string>
  /** Plan assigned when a subscription is canceled or no mapping is found. Must exist in `plans.definitions`. */
  defaultPlan: string
  webhook?: {
    /** Mount path. Default `'/webhooks/billing'`. Must be in `config.ignorePaths`. */
    path?: string
    /** BullMQ queue for `ProcessBillingEventJob`. Default `'billing-events'`. */
    queueName?: string
    /** Retention for `billing_processed_events.completed` rows. Default 90 (Stripe's max retry window). */
    idempotencyTtlDays?: number
    /** Hard-fail webhook delivery from non-Stripe IPs. Default `false`. */
    enforceIpAllowlist?: boolean
    /** CIDR/IP list. Default fetched from Stripe's published ranges (cached 24h). */
    allowedIps?: string[]
  }
  /** Dunning state-machine config: what happens after `invoice.payment_failed` retries. */
  dunning?: {
    /** After this many failed attempts, mark `status='past_due'` and emit `PaymentFailed{final:true}`. Default 3 (matches Stripe Smart Retries). */
    maxAttempts?: number
    /**
     * Action when dunning hits `maxAttempts`. Default `'none'`.
     *
     *   - `'none'`: only emit `PaymentFailed{final:true}`. The host's
     *     listener decides what to do (downgrade, send email, block).
     *   - `'downgrade'`: in addition to the event, immediately reassign
     *     the tenant to `defaultPlan` via `QuotaService.assignPlan`.
     *     The Stripe subscription (and the local mirror's `planName`)
     *     stay on the upgraded plan; only the enforced quota drops.
     *     A successful retry that lands `customer.subscription.updated
     *     (active)` re-resolves the original product mapping and
     *     restores the upgraded plan automatically.
     */
    action?: 'none' | 'downgrade'
    /**
     * Days to wait after `past_due` before applying `action`. Default 0
     * (apply immediately). When `> 0`, the downgrade is scheduled and applied
     * by `tenant:billing:sweep` once the window elapses, so run that command
     * on a cron (hourly suggested) if you set a grace period.
     */
    gracePeriodDays?: number
  }
  /**
   * Days before `trial_end` to emit `TrialEnding`. Default 3. Stripe fires a
   * native `trial_will_end` webhook ~3 days out; for Paddle/Lemon Squeezy (no
   * such webhook) `tenant:billing:sweep` synthesises the notice from this
   * lead time. Each subscription is notified exactly once across providers.
   */
  trialEndingLeadDays?: number
  /** Send `QuotaWarningMailer` on `TenantQuotaExceeded`. Requires `@adonisjs/mail`. Default `false`. */
  notifyOnQuotaExceeded?: boolean
  /**
   * Auto-suspend a tenant when a terminal payment failure fires
   * (`PaymentFailed` with `final: true`, or `SubscriptionCanceled` with
   * `reason: 'dunning_failed'`). Blocks all API access until recovery or manual
   * reactivation, and dispatches `TenantSuspended` for cache invalidation.
   * Opt-in. Default `false`.
   */
  suspendOnPaymentFailure?: boolean
  /**
   * When `suspendOnPaymentFailure` is true, auto-reactivate a suspended tenant
   * on `PaymentSucceeded` (transition back to `active`, dispatch
   * `TenantActivated`). Ignored unless `suspendOnPaymentFailure` is true.
   * Opt-in. Default `false`.
   */
  reactivateOnPaymentSuccess?: boolean
  /** What to do with the provider subscription on tenant hard-delete. Default `'cancel'`. */
  onTenantDelete?: 'cancel' | 'detach' | 'preserve'
  /**
   * Auto-bridge `QuotaService.track` to the active driver's usage metering.
   * Requires `plans.emitTracked = true` and a driver that supports
   * `usage_metering`. Each entry maps a quota name to the provider meter event
   * name. Reports are batched in-memory and flushed every `batchFlushMs`
   * (default 10_000ms) per (tenant, meter).
   */
  usageMapping?: Record<string, { meterEventName: string; batchFlushMs?: number }>
  observability?: {
    /** Emit Prometheus metrics via MetricsService. Default `true` if MetricsService is active. */
    metrics?: boolean
    /** Redact PII (email, last4, phone, etc.) in logs and audit entries. Default `true`. */
    redactPii?: boolean
  }
  /**
   * Opt-in fiscal features (multi-country tax snapshots + an append-only invoice
   * read model). The DDL is published separately at configure time
   * (`node ace configure @adonisjs-lasagna/billing`, then answer yes, or
   * `LASAGNA_BILLING_FISCAL=1`); this block gates the runtime behaviour. The
   * provider stays the source of truth for tax and invoices. We only record
   * snapshots for reporting/reconciliation (no local invoice numbering, no tax
   * engine). Disabled when absent.
   */
  fiscal?: {
    /**
     * Master switch for the fiscal runtime behaviour: capturing the provider's
     * tax breakdown onto payment events / the ledger, writing the
     * `billing_invoice_snapshots` read model, and mounting the invoice
     * read-through routes. Default `false`.
     */
    enabled?: boolean
    /**
     * Pass Stripe `automatic_tax: { enabled: true }` at checkout so the provider
     * computes tax. The provider does the math; we only snapshot the result.
     * Default `false`.
     */
    automaticTax?: boolean
  }
}

/**
 * Augment core's open `SatelliteConfigRegistry` so `getConfig().billing` (and any
 * `MultitenancyConfig` consumer) is typed wherever the billing satellite is
 * imported. The augmentation lives in this package's compilation only, so core
 * (which never imports billing) keeps a `billing`-free public type. This is
 * the mechanism that replaces the old hard-coded `billing?: BillingConfig` field
 * on core's `MultitenancyConfig`.
 */
declare module '@adonisjs-lasagna/saas-tenancy/types' {
  interface SatelliteConfigRegistry {
    /** Optional billing satellite. See {@link BillingConfig}. */
    billing?: BillingConfig
  }
}

/**
 * The host's `config/multitenancy.ts` shape with the billing block present.
 * Mirrors the reporting satellite's `MultitenancyConfigWithReporting` so every
 * config-bearing satellite exposes the same authoring surface.
 */
export type MultitenancyConfigWithBilling = MultitenancyConfig & { billing?: BillingConfig }

/**
 * Identity helper for IDE autocomplete + type-checking when authoring the
 * `billing` block of `config/multitenancy.ts`. No runtime effect.
 */
export function defineBillingConfig(config: BillingConfig): BillingConfig {
  return config
}
