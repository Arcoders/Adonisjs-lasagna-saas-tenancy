import app from '@adonisjs/core/services/app'
import { DateTime } from 'luxon'
import BillingService from '../services/billing_service.js'
import StripeProcessedEvent from '../models/satellites/stripe_processed_event.js'
import StripeSubscription from '../models/satellites/stripe_subscription.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { CheckResult, HealthCheckFn } from '@adonisjs-lasagna/saas-tenancy/health'

/**
 * Threshold above which the Stripe API call is considered slow and the
 * health check reports `pass` with `meta.degraded = true`. Exported so
 * tests can trigger the degraded branch without race conditions on a
 * hard-coded magic number — bumping this constant in code requires
 * updating the test that asserts "API > threshold ⇒ degraded".
 */
export const SLOW_API_THRESHOLD_MS = 3_000
const STALE_PROCESSING_WARN_MIN = 5
const STALE_PROCESSING_FAIL_MIN = 15

/**
 * Health check for the billing satellite. Returns three flavours:
 *
 *   - `pass` — Stripe API responding < 3s, secret present, and (when
 *     subscriptions exist locally) something processed within the last 5
 *     minutes — i.e. webhooks are flowing.
 *   - `pass` with `degraded` flag in meta — API > 3s OR last processed
 *     between 5 and 15 minutes (no fresh activity but we have older subs).
 *   - `fail` — API key invalid / unreachable, webhook secret missing, or
 *     last processed >15min when active subs exist.
 *
 * The check skips quietly (`pass` with `meta.skipped: true`) when
 * `config.billing` is unset — billing is optional, never a global
 * dependency.
 */
export const billingHealthCheck: HealthCheckFn = async (): Promise<CheckResult> => {
  const cfg = getConfig().billing
  if (!cfg) {
    return {
      status: 'pass',
      durationMs: 0,
      message: 'billing not configured',
      meta: { skipped: true },
    }
  }

  if (!cfg.stripe.webhookSecret) {
    return { status: 'fail', durationMs: 0, message: 'webhook secret missing' }
  }

  const start = Date.now()
  let apiOk = false
  let apiError: string | undefined
  try {
    const billing = await app.container.make(BillingService)
    const stripe = await billing.getClient()
    await stripe.balance.retrieve()
    apiOk = true
  } catch (err) {
    apiError = (err as Error)?.message ?? 'unknown error'
  }
  const apiDurationMs = Date.now() - start

  if (!apiOk) {
    return {
      status: 'fail',
      durationMs: apiDurationMs,
      message: `Stripe API unreachable: ${apiError}`,
    }
  }

  // Webhook freshness — only relevant when there's something to process.
  const activeSubsCount = await StripeSubscription.query()
    .whereIn('status', ['active', 'past_due', 'trialing'])
    .count('* as total')
  const firstRow = activeSubsCount[0] as unknown as {
    $extras?: { total?: number | string }
    total?: number | string
  }
  const total = Number(firstRow?.$extras?.total ?? firstRow?.total ?? 0)

  let stalenessNote: string | undefined
  let degraded = false
  if (total > 0) {
    const latest = await StripeProcessedEvent.query()
      .whereNotNull('completedAt')
      .orderBy('completedAt', 'desc')
      .first()
    if (latest && latest.completedAt) {
      const ageMin = DateTime.utc().diff(latest.completedAt, 'minutes').minutes
      if (ageMin > STALE_PROCESSING_FAIL_MIN) {
        return {
          status: 'fail',
          durationMs: apiDurationMs,
          message: `last webhook processed ${Math.floor(ageMin)} min ago — stale`,
          meta: { last_processed_at: latest.completedAt.toISO(), active_subs: total },
        }
      }
      if (ageMin > STALE_PROCESSING_WARN_MIN) {
        degraded = true
        stalenessNote = `last webhook processed ${Math.floor(ageMin)} min ago`
      }
    }
  }

  if (apiDurationMs > SLOW_API_THRESHOLD_MS) degraded = true

  return {
    status: 'pass',
    durationMs: apiDurationMs,
    message: degraded ? `degraded${stalenessNote ? ' — ' + stalenessNote : ''}` : 'ok',
    meta: { degraded, api_duration_ms: apiDurationMs, active_subs: total },
  }
}
