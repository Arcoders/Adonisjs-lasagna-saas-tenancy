import { DateTime } from 'luxon'
import BillingProcessedEvent from '../models/satellites/billing_processed_event.js'
import BillingSubscription from '../models/satellites/billing_subscription.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { getActiveBillingDriver } from '../services/billing/active_billing_driver.js'
import type { CheckResult, HealthCheckFn } from '@adonisjs-lasagna/saas-tenancy/health'

/**
 * Threshold above which the provider API probe is considered slow and the
 * check reports `pass` with `meta.degraded = true`. Exported so tests can
 * trigger the degraded branch deterministically.
 */
export const SLOW_API_THRESHOLD_MS = 3_000
const STALE_PROCESSING_WARN_MIN = 5
const STALE_PROCESSING_FAIL_MIN = 15

/**
 * Health check for the billing satellite. Provider-agnostic — probes the active
 * driver via its optional `healthCheck()` and reports:
 *
 *   - `pass` — driver reachable (or no probe available), and (when subs exist)
 *     a webhook processed within the last 5 minutes.
 *   - `pass` + `degraded` — probe > 3s, OR last processed 5–15 min ago.
 *   - `fail` — driver probe failed, OR last processed > 15 min with active subs.
 *
 * Skips quietly (`pass`, `meta.skipped`) when `config.billing` is unset.
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

  const driver = await getActiveBillingDriver()

  const start = Date.now()
  let apiOk = true
  let apiError: string | undefined
  if (driver.healthCheck) {
    try {
      await driver.healthCheck()
    } catch (err) {
      apiOk = false
      apiError = (err as Error)?.message ?? 'unknown error'
    }
  }
  const apiDurationMs = Date.now() - start

  if (!apiOk) {
    return {
      status: 'fail',
      durationMs: apiDurationMs,
      message: `billing provider "${driver.name}" unreachable: ${apiError}`,
    }
  }

  // Webhook freshness — only relevant when there's something to process.
  const activeSubsCount = await BillingSubscription.query()
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
    const latest = await BillingProcessedEvent.query()
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
    meta: { degraded, api_duration_ms: apiDurationMs, active_subs: total, provider: driver.name },
  }
}
